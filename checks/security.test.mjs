import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccessToken, requireAccess, rejectCrossOrigin, equalSecret, securityHeaders, ACCESS_ISSUER, ACCESS_AUDIENCE, IMAP_ACCESS_AUDIENCE } from '../shared/security.mjs';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key' };
const encode = data => Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64url');
async function sign(claims = {}, header = {}) {
  const payload = { iss: ACCESS_ISSUER, aud: [ACCESS_AUDIENCE], exp: Date.now() / 1000 + 60, ...claims };
  const data = `${encode({ alg: 'RS256', kid: 'test-key', ...header })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(signature).toString('base64url')}`;
}
test('accepts a correctly signed Access JWT', async () => assert.equal((await validateAccessToken(await sign(), [jwk])).iss, ACCESS_ISSUER));
test('denies expired, wrong-audience, wrong-issuer and future tokens', async () => {
  for (const claims of [{ exp: 1 }, { aud: ['other'] }, { iss: 'https://evil.example' }, { nbf: Date.now() / 1000 + 3600 }, { exp: '9999999999' }]) await assert.rejects(() => sign(claims).then(t => validateAccessToken(t, [jwk])));
});
test('denies algorithm substitution, unknown keys and forged signatures', async () => {
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }]) await assert.rejects(() => sign({}, header).then(t => validateAccessToken(t, [jwk])));
  const token = await sign();
  await assert.rejects(() => validateAccessToken(token.slice(0, -15) + 'aaaaaaaaaaaaaaa', [jwk]));
});
test('fails closed without Access or with a spoofed identity header', async () => {
  assert.equal(await requireAccess(new Request('https://mail.ionacs.com/api/mails', { headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' } })), false);
});
test('rejects cross-origin mutations and allows the current site', () => {
  assert.equal(rejectCrossOrigin(new Request('https://mail.ionacs.com/api/send_mail', { method: 'POST', headers: { Origin: 'https://evil.example' } })), true);
  assert.equal(rejectCrossOrigin(new Request('https://mail.ionacs.com/api/send_mail', { method: 'POST', headers: { Origin: 'https://mail.ionacs.com' } })), false);
});
test('compares admin secrets without direct string equality', async () => {
  assert.equal(await equalSecret('test-only', 'test-only'), true);
  assert.equal(await equalSecret('test-onlz', 'test-only'), false);
  assert.equal(await equalSecret('', 'test-only'), false);
});
test('sensitive responses are uncached and prevent framing', () => {
  const response = securityHeaders(new Response('private'), { html: true });
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});


test('IMAP service identity cannot authenticate the web mailbox or admin audience', async () => {
  for (const aud of [IMAP_ACCESS_AUDIENCE, [IMAP_ACCESS_AUDIENCE]]) {
    const service = await sign({ aud });
    await assert.rejects(() => validateAccessToken(service, [jwk]));
    assert.deepEqual((await validateAccessToken(service, [jwk], Date.now() / 1000, IMAP_ACCESS_AUDIENCE)).aud, aud);
  }
  for (const aud of ['other', null, 42, { includes: IMAP_ACCESS_AUDIENCE }]) {
    await assert.rejects(() => sign({ aud }).then(token => validateAccessToken(token, [jwk], Date.now() / 1000, IMAP_ACCESS_AUDIENCE)));
  }
  await assert.rejects(() => sign().then(token => validateAccessToken(token, [jwk], Date.now() / 1000, IMAP_ACCESS_AUDIENCE)));
});
