import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnstileLoader } from '../public/turnstile-loader.mjs';

function fixture() {
  const scripts = [], browser = { turnstile: { nodeType: 1 } };
  const doc = { createElement: () => ({ remove() { this.removed = true; } }), head: { append(script) { scripts.push(script); } } };
  return { browser, scripts, load: createTurnstileLoader(browser, doc) };
}
test('DOM named properties cannot masquerade as loaded Turnstile; concurrent forms share one script', async () => {
  const { browser, scripts, load } = fixture();
  const first = load(), second = load();
  assert.equal(first, second);
  assert.equal(scripts.length, 1);
  browser.turnstile = { render() {} };
  browser.ionacsTurnstileReady();
  await Promise.all([first, second]);
  await load();
  assert.equal(scripts.length, 1);
});
test('failed Turnstile download can be retried without leaving a broken script', async () => {
  const { browser, scripts, load } = fixture();
  const failed = load();
  scripts[0].onerror();
  await assert.rejects(failed, /人机验证加载失败/);
  assert.equal(scripts[0].removed, true);
  const retried = load();
  assert.equal(scripts.length, 2);
  browser.turnstile = { render() {} };
  browser.ionacsTurnstileReady();
  await retried;
});
