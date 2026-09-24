import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the real login entrypoint with an in-memory DOM and API. No browser,
// credentials or live DingTalk authorization are used by these tests.
function loginPage() {
  const nodes = new Map();
  const listeners = new Map();
  const location = { href: 'http://localhost:9988/login.html', origin: 'http://localhost:9988', pathname: '/login.html', search: '' };
  const document = {
    visibilityState: 'visible', hasFocus: () => true, addEventListener() {},
    querySelectorAll: () => [],
    querySelector(selector) {
      if (!nodes.has(selector)) {
        const classes = new Set();
        nodes.set(selector, { textContent: '', innerHTML: '', value: '', dataset: {}, contentWindow: {},
          addEventListener() {}, classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } });
      }
      return nodes.get(selector);
    }
  };
  const window = { location, addEventListener: (name, fn) => listeners.set(name, fn), history: { replaceState() {} } };
  const source = readFileSync('frontend/src/pages/login.js', 'utf8').replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, { window, document, URL, URLSearchParams, Blob, API_BASE_URL: '',
    navigator: { userAgent: 'node regression test', sendBeacon: () => true },
    api: async () => ({ ok: true, user: null }) });
  return { location, message: data => listeners.get('message')({ data, origin: 'https://login.dingtalk.com', source: document.querySelector('#dingtalkFrame').contentWindow }) };
}

test('native DingTalk authorization code navigates to same-origin callback with state intact', () => {
  for (const payload of [{ code: 'test-code', state: 'test-state' }, { data: { authCode: 'test-code', state: 'test-state' } }]) {
    const page = loginPage();
    page.message(payload);
    const url = new URL(page.location.href);
    assert.equal(url.origin, 'http://localhost:9988');
    assert.equal(url.pathname, '/api/auth/dingtalk/callback');
    assert.equal(url.searchParams.get('code'), 'test-code');
    assert.equal(url.searchParams.get('state'), 'test-state');
  }
});

test('DingTalk redirect URL and existing handoff message still navigate', () => {
  const page = loginPage();
  page.message({ redirectUrl: 'http://localhost:9988/api/auth/dingtalk/callback?code=test-code' });
  assert.equal(new URL(page.location.href).pathname, '/api/auth/dingtalk/callback');
  page.message({ type: 'xihang:dingtalk-auth', target: 'http://localhost:9988/login.html?auth_handoff=test-token' });
  assert.equal(new URL(page.location.href).searchParams.get('auth_handoff'), 'test-token');
});
