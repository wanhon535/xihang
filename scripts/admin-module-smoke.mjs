import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { getPool, initDatabase } from '../backend/src/db.js';

dotenv.config();

const runId = `module_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const port = Number(process.env.MODULE_SMOKE_PORT || 2401);
const baseUrl = `http://127.0.0.1:${port}`;
const password = `Module${Date.now()}!Aa1`;
const createdUserIds = [];

let serverProcess = null;
const db = getPool();

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async request(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      redirect: options.redirect || 'follow',
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(options.headers || {})
      }
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
    return { status: response.status, headers: response.headers, payload };
  }

  async login(username) {
    const response = await this.request('/api/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    assertStatus(response, 200, `${this.label} login`);
    assert(this.cookie, `${this.label} login should create cookie`);
    return response.payload.user;
  }
}

try {
  await initDatabase();
  const fixtures = await seedUsers();
  await startServer();

  const results = [];
  await runScenario(results, 'auth me and logout', () => testAuthMeAndLogout(fixtures));
  await runScenario(results, 'admin overview settings audit backup', () => testAdminSettingsAuditBackup(fixtures));
  await runScenario(results, 'admin saves and restores site matrix', () => testAdminGroupSaveRestore(fixtures));
  await runScenario(results, 'redirect targets', () => testRedirectTargets(fixtures));
  await runScenario(results, 'validation errors', () => testValidationErrors(fixtures));
  await runScenario(results, 'password login rate limit', () => testPasswordRateLimit());

  console.log(JSON.stringify({ ok: true, runId, baseUrl, scenarios: results }, null, 2));
} finally {
  await cleanup();
}

async function seedUsers() {
  return {
    admin: await createUser('admin', 'admin'),
    member: await createUser('member', 'member')
  };
}

async function createUser(suffix, role) {
  const username = `${runId}_${suffix}`;
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await db.query(
    `INSERT INTO users (username, password_hash, nick, role, status, must_change_password)
     VALUES (?, ?, ?, ?, 'active', 0)`,
    [username, passwordHash, username, role]
  );
  createdUserIds.push(result.insertId);
  return { id: result.insertId, username, role };
}

async function startServer() {
  serverProcess = spawn(process.execPath, ['backend/src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:2223,http://localhost:2223'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  for (let index = 0; index < 60; index += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`temporary backend exited early: ${stderr.trim()}`);
    }
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      if (health.ok) {
        return;
      }
    } catch {
      // Wait until the temporary backend accepts HTTP traffic.
    }
    await wait(250);
  }
  throw new Error(`temporary backend did not become healthy: ${stderr.trim()}`);
}

async function runScenario(results, name, task) {
  await task();
  results.push({ name, ok: true });
}

async function testAuthMeAndLogout({ member }) {
  const client = new Client('member-session');
  await client.login(member.username);

  const me = await client.request('/api/auth/me');
  assertStatus(me, 200, 'auth me');
  assert(me.payload.user?.username === member.username, 'auth me should return current user');

  assertStatus(await client.request('/api/auth/logout', { method: 'POST', body: '{}' }), 200, 'logout');
  const afterLogout = await client.request('/api/auth/me');
  assertStatus(afterLogout, 200, 'auth me after logout');
  assert(afterLogout.payload.user === null, 'auth me after logout should be anonymous');
  assertStatus(await client.request('/api/nav/groups'), 401, 'nav after logout blocked');
}

async function testAdminSettingsAuditBackup({ admin }) {
  const client = new Client('admin-control');
  await client.login(admin.username);

  const overview = await client.request('/api/admin/overview');
  assertStatus(overview, 200, 'admin overview');
  assert(Number.isFinite(Number(overview.payload.overview?.totalUsers)), 'overview should include totalUsers');

  const settingsResponse = await client.request('/api/admin/settings');
  assertStatus(settingsResponse, 200, 'admin settings get');
  const originalSettings = settingsResponse.payload.settings;
  assert(originalSettings && typeof originalSettings === 'object', 'settings payload missing');

  const updatedSettings = {
    ...originalSettings,
    backupRetentionDays: String(Math.min(Number(originalSettings.backupRetentionDays || 30) + 1, 365))
  };
  try {
    const update = await client.request('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: updatedSettings })
    });
    assertStatus(update, 200, 'admin settings update');
    assert(update.payload.settings.backupRetentionDays === updatedSettings.backupRetentionDays, 'settings update mismatch');

    const audit = await client.request('/api/admin/audit-logs?limit=20');
    assertStatus(audit, 200, 'admin audit logs');
    assert(Array.isArray(audit.payload.logs), 'audit logs should be array');
    assert(audit.payload.logs.some((log) => log.action === 'settings.update'), 'settings update audit log missing');

    const backup = await client.request('/api/admin/backup');
    assertStatus(backup, 200, 'admin backup');
    assert(backup.payload.snapshot?.groups, 'backup snapshot should include groups');
    const backupText = JSON.stringify(backup.payload.snapshot);
    assert(!backupText.includes('password_hash'), 'backup must not expose password_hash');
    assert(!backupText.includes(password), 'backup must not expose plaintext test password');
  } finally {
    await client.request('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: originalSettings })
    }).catch(() => {});
  }
}

async function testAdminGroupSaveRestore({ admin, member }) {
  const client = new Client('admin-groups');
  await client.login(admin.username);

  const original = await client.request('/api/admin/groups');
  assertStatus(original, 200, 'admin groups original');
  const originalGroups = original.payload.groups || [];
  const tempGroupName = `${runId}_saved_group`;
  const nextGroups = [
    ...originalGroups,
    {
      name: tempGroupName,
      description: 'temporary group created through admin save API',
      sites: [
        {
          name: `${runId}_saved_site`,
          url: 'https://example.com/module-saved-site',
          description: 'temporary saved site',
          tags: [runId, 'saved'],
          visibility: 'users',
          allowedRoles: [],
          allowedUserIds: [member.id]
        }
      ]
    }
  ];

  try {
    const save = await client.request('/api/admin/groups', {
      method: 'PUT',
      body: JSON.stringify({ groups: nextGroups })
    });
    assertStatus(save, 200, 'admin groups save');
    assert(
      (save.payload.groups || []).some((group) => group.name === tempGroupName),
      'saved group should be returned after admin groups save'
    );

    const memberClient = new Client('member-after-group-save');
    await memberClient.login(member.username);
    const nav = await memberClient.request('/api/nav/groups');
    assertStatus(nav, 200, 'member nav after group save');
    const savedSite = (nav.payload.groups || [])
      .flatMap((group) => group.sites || [])
      .find((site) => site.name === `${runId}_saved_site`);
    assert(savedSite, 'member should see assigned saved site');
  } finally {
    const restore = await client.request('/api/admin/groups', {
      method: 'PUT',
      body: JSON.stringify({ groups: originalGroups })
    });
    assertStatus(restore, 200, 'admin groups restore');
  }
}

async function testRedirectTargets({ member }) {
  const anonymous = new Client('anonymous-redirect');
  assertStatus(
    await anonymous.request('/api/sso/authorize?siteId=1', { redirect: 'manual' }),
    401,
    'anonymous SSO authorize should not redirect'
  );

  const dingTalkRedirect = await anonymous.request('/api/auth/dingtalk', { redirect: 'manual' });
  assertStatus(dingTalkRedirect, 302, 'DingTalk entry redirect');
  const dingTalkLocation = dingTalkRedirect.headers.get('location') || '';
  assert(
    dingTalkLocation.startsWith('https://login.dingtalk.com/oauth2/auth') ||
      dingTalkLocation.startsWith('http://127.0.0.1:2223/login.html') ||
      dingTalkLocation.startsWith('http://localhost:2223/login.html'),
    `unexpected DingTalk redirect target: ${dingTalkLocation}`
  );

  const client = new Client('member-redirect');
  await client.login(member.username);
  assertStatus(
    await client.request('/api/sso/authorize', { redirect: 'manual' }),
    400,
    'missing SSO target should be rejected without redirect'
  );
  assertStatus(
    await client.request('/api/sso/authorize?redirect=ftp%3A%2F%2Fexample.com', { redirect: 'manual' }),
    400,
    'invalid SSO redirect protocol rejected'
  );

  const apiSource = await fs.readFile('frontend/src/api.js', 'utf8');
  const loginSource = await readFirstExistingFile(['frontend/src/pages/login.js', 'frontend/src/login.js']);
  const changePasswordSource = await readFirstExistingFile([
    'frontend/src/pages/change-password.js',
    'frontend/src/change-password.js'
  ]);
  const mainSource = await readFirstExistingFile(['frontend/src/pages/main.js', 'frontend/src/main.js']);

  assert(apiSource.includes("window.location.href = `/login.html${query}`"), 'redirectToLogin target changed');
  assert(apiSource.includes("window.location.href = '/change-password.html'"), 'requireUser must-change redirect missing');
  assert(apiSource.includes("url.searchParams.set('siteId', site.id)"), 'SSO frontend should prefer siteId');
  assert(loginSource.includes("payload.user?.mustChangePassword ? '/change-password.html' : '/'"), 'password login redirect target missing');
  assert(loginSource.includes("payload.user.mustChangePassword ? '/change-password.html' : '/'"), 'existing-session redirect target missing');
  assert(loginSource.includes("payload.user?.mustChangePassword ? '/change-password.html' : '/'"), 'handoff redirect target missing');
  assert(changePasswordSource.includes("window.location.href = '/'"), 'change-password success redirect missing');
  assert(mainSource.includes('createSsoUrl(site)'), 'workspace cards should generate SSO URLs from site objects');
}

async function testValidationErrors({ member }) {
  const client = new Client('member-validation');
  await client.login(member.username);

  assertErrorStatus(
    await client.request('/api/vault/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: `${runId}_invalid_vault`,
        loginUsername: 'tester',
        password: 'secret',
        url: 'ftp://not-supported.example.com'
      })
    }),
    'invalid vault url should be rejected'
  );

  assertStatus(
    await client.request('/api/sso/verify', {
      method: 'POST',
      body: JSON.stringify({ ticket: 'not-a-valid-ticket' })
    }),
    401,
    'invalid SSO ticket blocked'
  );

  assertErrorStatus(
    await client.request('/api/user/workspace-theme/background', {
      method: 'POST',
      body: JSON.stringify({ mimeType: 'image/png', dataUrl: 'not-valid-base64' })
    }),
    'invalid background upload rejected'
  );
}

async function testPasswordRateLimit() {
  const username = `${runId}_rate_target`;
  let last;
  for (let index = 0; index < 11; index += 1) {
    last = await new Client(`rate-${index}`).request('/api/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ username, password: `wrong-${index}` })
    });
  }
  assertStatus(last, 429, 'password login rate limit');
}

async function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await Promise.race([once(serverProcess, 'exit'), wait(2000)]).catch(() => {});
  }

  if (createdUserIds.length > 0) {
    await db
      .query(`DELETE FROM users WHERE id IN (${createdUserIds.map(() => '?').join(',')})`, createdUserIds)
      .catch(() => {});
  }
  await db.query('DELETE FROM app_sessions WHERE session_data LIKE ?', [`%${runId}%`]).catch(() => {});
  await db.end().catch(() => {});
}

function assertStatus(result, expectedStatus, label) {
  assert(
    result.status === expectedStatus,
    `${label}: expected HTTP ${expectedStatus}, got ${result.status} ${JSON.stringify(result.payload)}`
  );
}

function assertErrorStatus(result, label) {
  assert(result.status >= 400, `${label}: expected error status, got ${result.status}`);
}

async function readFirstExistingFile(paths) {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(`None of these files exist: ${paths.join(', ')}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
