// The existing TP-Auth application remains the source of identity and policy.
export const ACCESS_ISSUER = 'https://synoauth.cloudflareaccess.com';
export const ACCESS_AUDIENCE = 'c26e1efce47eaa8751ad284778ed797ca58d5112e1d62e404c056ea351b6be09';
export const MAIL_ORIGIN = 'https://mail.ionacs.com';
const allowedOrigins = new Set([MAIL_ORIGIN, 'https://m.ionacs.com']);
let publicKeys = [], expires = 0, lastFetch = 0;

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

export async function validateAccessToken(token, keys, now = Date.now() / 1000) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error('Invalid algorithm');
  if (claims.iss !== ACCESS_ISSUER || !Array.isArray(claims.aud) || !claims.aud.includes(ACCESS_AUDIENCE)
    || !Number.isFinite(claims.exp) || claims.exp <= now
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))) throw new Error('Invalid claims');
  const jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256'));
  if (!jwk) throw new Error('Unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Invalid signature');
  return claims;
}

export async function requireAccess(request) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(decode(token.split('.')[0])));
    const now = Date.now();
    if (now > expires || (!publicKeys.some(k => k.kid === header.kid) && now - lastFetch > 30000)) {
      lastFetch = now;
      const response = await fetch(`${ACCESS_ISSUER}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return false;
      const data = await response.json();
      if (!Array.isArray(data.keys)) return false;
      publicKeys = data.keys; expires = now + 300000;
    }
    return await validateAccessToken(token, publicKeys);
  } catch { return false; }
}

export function isAllowedOrigin(origin) { return allowedOrigins.has(origin); }
export function rejectCrossOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) return true;
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Sec-Fetch-Site') === 'cross-site';
}

export async function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const encode = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encode.encode(expected));
  const key = await crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encode.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encode.encode(actual));
}

export function securityHeaders(response, { html = false } = {}) {
  const result = new Response(response.body, response);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  result.headers.set('Strict-Transport-Security', 'max-age=31536000');
  result.headers.set('Cache-Control', 'private, no-store');
  result.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (html) result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' blob: https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests");
  return result;
}
