import { equalSecret } from './security.mjs';

const ITERATIONS = 100000;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('密码需要 12–128 个字符，请使用不重复的长密码。');
  }
}

export async function passwordDigest(password) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(password)));
}

export async function hashPasswordDigest(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid password digest');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(digest), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2-sha256-v1$${ITERATIONS}$${hex(salt)}$${hex(bits)}`;
}

export async function hashPassword(password) {
  validatePassword(password);
  return hashPasswordDigest(await passwordDigest(password));
}

// Legacy clients submitted a SHA-256 digest. Salt and stretch it server-side,
// and upgrade existing unsalted records only after successful verification.
export async function verifyPassword(password, stored, format = 'plain') {
  if (typeof password !== 'string' || password.length > 128 || !password.length) return false;
  const digest = format === 'sha256' ? password : await passwordDigest(password);
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  if (typeof stored !== 'string' || !stored) {
    await hashPasswordDigest(digest); // Avoid the fast unknown-account path.
    return false;
  }
  if (/^[a-f0-9]{64}$/.test(stored)) return equalSecret(digest, stored);
  const match = /^pbkdf2-sha256-v1\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored);
  if (!match || Number(match[1]) !== ITERATIONS) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(digest), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(match[2]), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return equalSecret(hex(bits), match[3]);
}

export function randomAppPassword() {
  return hex(crypto.getRandomValues(new Uint8Array(24)));
}
