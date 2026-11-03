import { Parser } from 'htmlparser2';
import ipaddr from 'ipaddr.js';
import { passwordDigest } from '../../shared/passwords.mjs';

const MAX_BYTES = 256 * 1024;
const TTL = 7 * 86400;
export function iconDataURL(value, type) {
  const bytes = new Uint8Array(value); let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}
export function publicAddress(address) {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}
export function iconURL(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password || url.href.length > 2048) throw new Error('unsafe_url');
  if (ipaddr.isValid(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) throw new Error('unsafe_host');
  url.hash = '';
  return url;
}
export async function boundedBytes(response, limit = MAX_BYTES, prefix = false) {
  if (!prefix && Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new Error('too_large'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('empty');
  const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if (size + value.length > limit) {
        if (!prefix) throw new Error('too_large');
        parts.push(value.slice(0, limit - size)); size = limit; break;
      }
      parts.push(value); size += value.length;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export function iconCandidates(html, page) {
  let base = page; const links = [];
  const parser = new Parser({ onopentag(name, attrs) {
    if (name === 'base' && attrs.href && base === page) { try { base = iconURL(new URL(attrs.href, page)).href; } catch {} }
    if (name === 'link' && attrs.href && /(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(attrs.rel || '') && links.length < 12) links.push(attrs.href);
  }});
  parser.end(html);
  const urls = [];
  for (const link of links) { try { urls.push(iconURL(new URL(link, base)).href); } catch {} }
  return [...new Set(urls)].slice(0, 4).concat(new URL('/favicon.ico', page).href);
}
export function imageType(bytes) {
  const start = String.fromCharCode(...bytes.slice(0, 12));
  if (bytes.length < 12) return null;
  if (bytes[0] === 137 && start.slice(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (start.startsWith('GIF87a') || start.startsWith('GIF89a')) return 'image/gif';
  if (start.startsWith('RIFF') && start.slice(8) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && (bytes[4] || bytes[5])) return 'image/x-icon';
  // Active formats (HTML/SVG/XML) are never served from the authenticated origin.
  return null;
}
async function checkDNS(host, request, signal) {
  const answers = await Promise.all(['A', 'AAAA'].map(async type => {
    const response = await request('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=' + type, { headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('dns_unavailable'); }
    const data = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16384)));
    if (data.Status !== 0) throw new Error('dns_unavailable');
    return (data.Answer || []).filter(row => row.type === 1 || row.type === 28).map(row => row.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('private_dns');
}
export async function discoverIcon(value, request = fetch) {
  // Only visit the homepage, never bookmark query strings, fragments or private paths.
  const start = iconURL(value).origin + '/';
  const signal = AbortSignal.timeout(12000);
  const checked = new Set(); let budget = 9;
  async function get(value) {
    let url = iconURL(value);
    for (let hop = 0; hop < 4; hop++) {
      if (--budget < 0) throw new Error('request_budget');
      if (!checked.has(url.hostname)) { await checkDNS(url.hostname, request, signal); checked.add(url.hostname); }
      const response = await request(url.href, { redirect: 'manual', signal, headers: { 'User-Agent': 'IONACS-Site-Icon/1.0', Accept: 'text/html,image/png,image/x-icon,image/webp,image/jpeg,image/gif;q=0.9', 'Cache-Control': 'no-cache' }, credentials: 'omit', cache: 'no-store' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location'); if (!location) throw new Error('redirect_missing');
        url = iconURL(new URL(location, url)); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('upstream_unavailable'); }
      return { response, url: url.href };
    }
    throw new Error('redirect_limit');
  }
  let candidates = [new URL('/favicon.ico', start).href];
  try {
    const { response, url } = await get(start);
    if (/text\/html|application\/xhtml\+xml/i.test(response.headers.get('Content-Type') || '')) candidates = iconCandidates(new TextDecoder().decode(await boundedBytes(response, 512 * 1024, true)), url);
    else await response.body?.cancel();
  } catch { /* A blocked homepage may still provide a public favicon. */ }
  for (const candidate of candidates) {
    try {
      const { response } = await get(candidate);
      const bytes = await boundedBytes(response), type = imageType(bytes);
      if (type) return { bytes, type };
    } catch { /* Try another declared icon, then favicon.ico. */ }
  }
  throw new Error('icon_unavailable');
}
export async function cachedIcon(env, bookmark, refresh = false, request = fetch) {
  const key = 'nav-site-icon:' + bookmark.address_id + ':' + await passwordDigest(iconURL(bookmark.url).origin);
  const cached = await env.WALLPAPERS.getWithMetadata(key, { type: 'arrayBuffer' });
  const time = Math.floor(Date.now() / 1000);
  if ((refresh ? cached.metadata?.attemptedAt > time - 60 : cached.metadata?.checkedAt > time - TTL)) return { ...cached, refreshed: false };
  try {
    const result = await discoverIcon(bookmark.url, request);
    const metadata = { type: result.type, checkedAt: time, attemptedAt: time, updatedAt: time };
    await env.WALLPAPERS.put(key, result.bytes, { metadata, expirationTtl: TTL * 4 });
    return { value: result.bytes, metadata, refreshed: true };
  } catch {
    // Preserve the last good icon on upstream failures, and back off failed reads.
    const metadata = { ...cached.metadata, attemptedAt: time, checkedAt: time - TTL + 300 };
    await env.WALLPAPERS.put(key, cached.value || new Uint8Array(), { metadata, expirationTtl: cached.value?.byteLength ? TTL * 4 : 300 });
    return { value: cached.value, metadata, refreshed: false, unavailable: true };
  }
}
