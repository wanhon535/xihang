#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:2222';
const baseUrl = normalizeBaseUrl(process.env.VERIFY_API_BASE_URL || DEFAULT_BASE_URL);
const username = process.env.VERIFY_USERNAME || '';
const password = process.env.VERIFY_PASSWORD || '';
const frontendOrigin = process.env.VERIFY_FRONTEND_ORIGIN || 'http://127.0.0.1:2223';
const cookieJar = new Map();
const results = [];

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function rememberCookies(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return;

  const cookiePair = setCookie.split(';')[0];
  const index = cookiePair.indexOf('=');
  if (index <= 0) return;

  cookieJar.set(cookiePair.slice(0, index), cookiePair.slice(index + 1));
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function request(path, options = {}) {
  const headers = {
    accept: 'application/json',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  const cookies = cookieHeader();
  if (cookies) {
    headers.cookie = cookies;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...options,
    headers
  });

  rememberCookies(response);

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  return {
    status: response.status,
    headers: response.headers,
    payload
  };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`ok - ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`not ok - ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectStatus(result, expected, label) {
  assert(
    result.status === expected,
    `${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.payload)}`
  );
}

function expectOkEnvelope(result, label) {
  assert(result.payload && typeof result.payload === 'object', `${label} should return JSON object`);
  assert(Object.prototype.hasOwnProperty.call(result.payload, 'ok'), `${label} should include ok field`);
}

async function verifyPublicEndpoints() {
  await check('health endpoint', async () => {
    const result = await request('/api/health');
    expectStatus(result, 200, '/api/health');
    assert(result.payload.ok === true, '/api/health should return ok=true');
    return result.payload;
  });

  await check('auth me unauthenticated envelope', async () => {
    const result = await request('/api/auth/me');
    expectStatus(result, 200, '/api/auth/me');
    expectOkEnvelope(result, '/api/auth/me');
    assert(Object.prototype.hasOwnProperty.call(result.payload, 'user'), '/api/auth/me should include user field');
    return { user: result.payload.user ? 'present' : null };
  });

  await check('protected nav rejects unauthenticated request', async () => {
    const result = await request('/api/nav/groups');
    expectStatus(result, 401, '/api/nav/groups without login');
    assert(result.payload.ok === false, '/api/nav/groups should return ok=false when unauthenticated');
    return result.payload.message || result.payload.error || '';
  });

  await check('admin overview rejects unauthenticated request', async () => {
    const result = await request('/api/admin/overview');
    expectStatus(result, 401, '/api/admin/overview without login');
    assert(result.payload.ok === false, '/api/admin/overview should return ok=false when unauthenticated');
    return result.payload.message || result.payload.error || '';
  });

  await check('invalid SSO ticket rejected', async () => {
    const result = await request('/api/sso/verify', {
      method: 'POST',
      body: JSON.stringify({ ticket: 'invalid-ticket-for-smoke-test' })
    });
    expectStatus(result, 401, '/api/sso/verify invalid ticket');
    assert(result.payload.ok === false, '/api/sso/verify should reject invalid ticket');
    return result.payload.message || result.payload.error || '';
  });

  await check('DingTalk URL endpoint is stable', async () => {
    const result = await request('/api/auth/dingtalk/url', {
      headers: { origin: frontendOrigin }
    });
    expectStatus(result, 200, '/api/auth/dingtalk/url');
    expectOkEnvelope(result, '/api/auth/dingtalk/url');
    assert(typeof result.payload.configured === 'boolean', 'DingTalk URL endpoint should expose configured boolean');

    if (result.payload.configured) {
      const authUrl = new URL(result.payload.authUrl);
      const scope = authUrl.searchParams.get('scope') || '';
      assert(scope.split(/\s+/).includes('openid'), 'DingTalk scope should include openid');
      if (scope.split(/\s+/).includes('Contact.User.Read')) {
        assert(authUrl.searchParams.get('prompt') === 'consent', 'DingTalk profile scope should request prompt=consent');
      }
      assert(authUrl.searchParams.get('redirect_uri'), 'DingTalk auth URL should include redirect_uri');
      return {
        configured: true,
        scope,
        prompt: authUrl.searchParams.get('prompt') || '',
        hasCorpId: authUrl.searchParams.has('corpId')
      };
    }

    return { configured: false, message: result.payload.message || '' };
  });
}

async function verifyAuthenticatedEndpoints() {
  if (!username || !password) {
    console.log('skip - authenticated checks require VERIFY_USERNAME and VERIFY_PASSWORD');
    return;
  }

  await check('password login', async () => {
    const result = await request('/api/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    expectStatus(result, 200, '/api/auth/password-login');
    assert(result.payload.ok === true, 'password login should return ok=true');
    assert(result.payload.user, 'password login should return user');
    return {
      id: result.payload.user.id,
      role: result.payload.user.role,
      mustChangePassword: Boolean(result.payload.user.mustChangePassword)
    };
  });

  const meResult = await request('/api/auth/me');
  const currentUser = meResult.payload.user;

  await check('auth me authenticated', async () => {
    expectStatus(meResult, 200, '/api/auth/me after login');
    assert(meResult.payload.ok === true, '/api/auth/me after login should return ok=true');
    assert(currentUser, '/api/auth/me after login should return user');
    return { id: currentUser.id, role: currentUser.role, mustChangePassword: Boolean(currentUser.mustChangePassword) };
  });

  if (currentUser?.mustChangePassword) {
    console.log('skip - protected business checks because this account must change password first');
    return;
  }

  await check('nav groups authenticated', async () => {
    const result = await request('/api/nav/groups');
    expectStatus(result, 200, '/api/nav/groups after login');
    assert(result.payload.ok === true, '/api/nav/groups after login should return ok=true');
    assert(Array.isArray(result.payload.groups), '/api/nav/groups should return groups array');
    return { groups: result.payload.groups.length };
  });

  await check('vault credentials authenticated', async () => {
    const result = await request('/api/vault/credentials');
    expectStatus(result, 200, '/api/vault/credentials after login');
    assert(result.payload.ok === true, '/api/vault/credentials should return ok=true');
    assert(Array.isArray(result.payload.credentials), '/api/vault/credentials should return credentials array');
    return { credentials: result.payload.credentials.length };
  });

  await check('workspace theme authenticated', async () => {
    const result = await request('/api/user/workspace-theme');
    expectStatus(result, 200, '/api/user/workspace-theme after login');
    assert(result.payload.ok === true, '/api/user/workspace-theme should return ok=true');
    return Object.keys(result.payload.theme || {});
  });

  await check('admin guard behavior', async () => {
    const result = await request('/api/admin/overview');
    if (currentUser.role === 'admin') {
      expectStatus(result, 200, '/api/admin/overview as admin');
      assert(result.payload.ok === true, '/api/admin/overview as admin should return ok=true');
      return { role: 'admin', allowed: true };
    }

    expectStatus(result, 403, '/api/admin/overview as member');
    assert(result.payload.ok === false, '/api/admin/overview as member should return ok=false');
    return { role: currentUser.role, allowed: false };
  });

  await check('logout', async () => {
    const result = await request('/api/auth/logout', {
      method: 'POST',
      body: '{}'
    });
    expectStatus(result, 200, '/api/auth/logout');
    assert(result.payload.ok === true, '/api/auth/logout should return ok=true');
    return result.payload;
  });
}

await verifyPublicEndpoints();
await verifyAuthenticatedEndpoints();

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failed.length === 0, baseUrl, total: results.length, failed }, null, 2));

if (failed.length > 0) {
  process.exit(1);
}

