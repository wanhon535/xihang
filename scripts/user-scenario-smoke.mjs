import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getPool, initDatabase } from '../backend/src/db.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const workspaceBackgroundRoot = path.join(rootDir, 'data', 'uploads', 'backgrounds');
const runId = `scenario_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const port = Number(process.env.SMOKE_PORT || 2399);
const baseUrl = `http://127.0.0.1:${port}`;
const password = `Smoke${Date.now()}!Aa1`;
const nextPassword = `${password}Next`;

const createdUserIds = [];
const uploadedFiles = [];
let createdGroupId = null;
let serverProcess = null;

class TestClient {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async request(pathname, options = {}) {
    const headers = {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...(options.headers || {})
    };
    const response = await fetch(`${baseUrl}${pathname}`, {
      redirect: options.redirect || 'follow',
      ...options,
      headers
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
    return {
      status: response.status,
      ok: response.ok,
      payload,
      headers: response.headers
    };
  }

  async login(username, loginPassword = password) {
    const result = await this.request('/api/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ username, password: loginPassword })
    });
    assertStatus(result, 200, `${this.label} password login`);
    assert(result.payload.user?.username === username, `${this.label} login user mismatch`);
    assert(this.cookie, `${this.label} login did not create a session cookie`);
    return result.payload.user;
  }
}

const db = getPool();

try {
  await initDatabase();
  const fixtures = await seedFixtures();
  await startServer();

  const results = [];
  await runScenario(results, '未登录访问控制', () => testAnonymousAccess());
  await runScenario(results, '密码登录边界', () => testPasswordLoginEdges(fixtures));
  await runScenario(results, '首次登录强制改密', () => testMustChangePassword(fixtures));
  await runScenario(results, '站点入口权限隔离', () => testNavigationPermissions(fixtures));
  await runScenario(results, 'SSO 授权与一次性票据', () => testSsoFlow(fixtures));
  await runScenario(results, '星钥库个人隔离', () => testVaultIsolation(fixtures));
  await runScenario(results, '工作台外观个人隔离', () => testWorkspaceThemeIsolation(fixtures));
  await runScenario(results, '背景上传和访问', () => testBackgroundUpload(fixtures));
  await runScenario(results, '后台管理权限', () => testAdminPermissions(fixtures));
  await runScenario(results, '钉钉配置接口', () => testDingTalkConfigEndpoint());

  console.log(JSON.stringify({ ok: true, runId, baseUrl, scenarios: results }, null, 2));
} finally {
  await cleanup();
}

async function seedFixtures() {
  const users = {
    admin: await createUser('admin', { role: 'admin' }),
    member: await createUser('member', { role: 'member' }),
    assigned: await createUser('assigned', { role: 'member' }),
    disabled: await createUser('disabled', { role: 'member', status: 'disabled' }),
    mustChange: await createUser('mustchange', { role: 'member', mustChangePassword: true })
  };

  const [groupResult] = await db.query(
    'INSERT INTO nav_groups (name, description, sort_order) VALUES (?, ?, ?)',
    [`${runId}_group`, 'user scenario smoke test', 99999]
  );
  createdGroupId = groupResult.insertId;

  const siteDefs = [
    ['all', 'https://example.com/smoke-all', 'all', [], [], 0],
    ['admins', 'https://example.com/smoke-admins', 'admins', [], [], 1],
    ['roles', 'https://example.com/smoke-roles', 'roles', ['member'], [], 2],
    ['users', 'https://example.com/smoke-users', 'users', [], [users.assigned.id], 3]
  ];

  const sites = {};
  for (const [key, url, visibility, roles, userIds, sortOrder] of siteDefs) {
    const [result] = await db.query(
      `INSERT INTO nav_sites
         (group_id, name, url, description, tags, visibility, allowed_roles, allowed_user_ids, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createdGroupId,
        `${runId}_${key}`,
        url,
        `${key} permission smoke site`,
        JSON.stringify([runId, key]),
        visibility,
        JSON.stringify(roles),
        JSON.stringify(userIds),
        sortOrder
      ]
    );
    sites[key] = { id: result.insertId, name: `${runId}_${key}`, url };
  }

  return { users, sites };
}

async function createUser(suffix, { role, status = 'active', mustChangePassword = false }) {
  const username = `${runId}_${suffix}`;
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await db.query(
    `INSERT INTO users (username, password_hash, nick, role, status, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [username, passwordHash, username, role, status, mustChangePassword ? 1 : 0]
  );
  createdUserIds.push(result.insertId);
  return { id: result.insertId, username, role, status, password };
}

async function startServer() {
  serverProcess = spawn(process.execPath, ['backend/src/server.js'], {
    cwd: rootDir,
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
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting until the temporary backend accepts connections.
    }
    await wait(250);
  }

  throw new Error(`temporary backend did not become healthy: ${stderr.trim()}`);
}

async function runScenario(results, name, task) {
  await task();
  results.push({ name, ok: true });
}

async function testAnonymousAccess() {
  const client = new TestClient('anonymous');
  assertStatus(await client.request('/api/health'), 200, 'health');
  const me = await client.request('/api/auth/me');
  assertStatus(me, 200, 'anonymous me');
  assert(me.payload.user === null, 'anonymous user should be null');
  assertStatus(await client.request('/api/nav/groups'), 401, 'anonymous nav blocked');
  assertStatus(await client.request('/api/admin/users'), 401, 'anonymous admin blocked');
}

async function testPasswordLoginEdges({ users }) {
  const wrong = await new TestClient('wrong-password').request('/api/auth/password-login', {
    method: 'POST',
    body: JSON.stringify({ username: users.member.username, password: 'not-the-password' })
  });
  assertStatus(wrong, 401, 'wrong password blocked');

  const disabled = await new TestClient('disabled').request('/api/auth/password-login', {
    method: 'POST',
    body: JSON.stringify({ username: users.disabled.username, password })
  });
  assertStatus(disabled, 403, 'disabled user blocked');
}

async function testMustChangePassword({ users }) {
  const client = new TestClient('must-change');
  const user = await client.login(users.mustChange.username);
  assert(user.mustChangePassword === true, 'must-change login should report password change required');

  const blockedNav = await client.request('/api/nav/groups');
  assertStatus(blockedNav, 403, 'must-change nav blocked');
  assert(blockedNav.payload.code === 'PASSWORD_CHANGE_REQUIRED', 'must-change block code mismatch');

  const changed = await client.request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: password, nextPassword })
  });
  assertStatus(changed, 200, 'must-change password update');
  assert(changed.payload.user?.mustChangePassword === false, 'must-change flag should be cleared');

  const nav = await client.request('/api/nav/groups');
  assertStatus(nav, 200, 'must-change nav after password update');
}

async function testNavigationPermissions({ users }) {
  const member = new TestClient('member');
  await member.login(users.member.username);
  const memberSites = await visibleSmokeSiteNames(member);
  assertSet(memberSites, [`${runId}_all`, `${runId}_roles`], 'member visible sites');

  const assigned = new TestClient('assigned');
  await assigned.login(users.assigned.username);
  const assignedSites = await visibleSmokeSiteNames(assigned);
  assertSet(assignedSites, [`${runId}_all`, `${runId}_roles`, `${runId}_users`], 'assigned visible sites');

  const admin = new TestClient('admin');
  await admin.login(users.admin.username);
  const adminSites = await visibleSmokeSiteNames(admin);
  assertSet(
    adminSites,
    [`${runId}_admins`, `${runId}_all`, `${runId}_roles`, `${runId}_users`],
    'admin visible sites'
  );
}

async function testSsoFlow({ users, sites }) {
  const member = new TestClient('member-sso');
  await member.login(users.member.username);

  const allowed = await member.request(`/api/sso/authorize?siteId=${sites.all.id}`, { redirect: 'manual' });
  assertStatus(allowed, 302, 'member allowed SSO');
  const location = allowed.headers.get('location') || '';
  assert(location.startsWith(sites.all.url), 'allowed SSO redirect target mismatch');
  const ticket = new URL(location).searchParams.get('sso_ticket');
  assert(ticket, 'allowed SSO redirect should include ticket');

  const verify = await member.request('/api/sso/verify', {
    method: 'POST',
    body: JSON.stringify({ ticket })
  });
  assertStatus(verify, 200, 'SSO ticket verify');
  assert(verify.payload.targetUrl === sites.all.url, 'SSO verify target mismatch');

  const replay = await member.request('/api/sso/verify', {
    method: 'POST',
    body: JSON.stringify({ ticket })
  });
  assertStatus(replay, 401, 'SSO ticket replay blocked');

  assertStatus(await member.request(`/api/sso/authorize?siteId=${sites.admins.id}`, { redirect: 'manual' }), 403, 'hidden siteId blocked');
  assertStatus(
    await member.request(`/api/sso/authorize?redirect=${encodeURIComponent('https://not-authorized.example.com')}`, {
      redirect: 'manual'
    }),
    403,
    'arbitrary redirect blocked'
  );
}

async function testVaultIsolation({ users }) {
  const member = new TestClient('member-vault');
  await member.login(users.member.username);
  const assigned = new TestClient('assigned-vault');
  await assigned.login(users.assigned.username);

  const created = await member.request('/api/vault/credentials', {
    method: 'POST',
    body: JSON.stringify({
      title: `${runId} credential`,
      loginUsername: `${runId}_login`,
      password: `${password}_vault`,
      category: `${runId}_project`,
      tags: [runId, 'vault'],
      url: '127.0.0.1:3306',
      notes: 'created by user scenario smoke'
    })
  });
  assertStatus(created, 201, 'vault create');
  const credentialId = created.payload.credential?.id;
  assert(credentialId, 'vault create should return credential id');
  assert(!Object.prototype.hasOwnProperty.call(created.payload.credential, 'password'), 'vault list payload must not expose password');

  const memberSecret = await member.request(`/api/vault/credentials/${credentialId}/secret`);
  assertStatus(memberSecret, 200, 'member can read own vault secret');
  assert(memberSecret.payload.secret?.password === `${password}_vault`, 'member vault secret mismatch');

  assertStatus(await assigned.request(`/api/vault/credentials/${credentialId}/secret`), 404, 'other user cannot read vault secret');
  assertStatus(
    await assigned.request(`/api/vault/credentials/${credentialId}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'hijack', password: 'hijack-password' })
    }),
    404,
    'other user cannot update vault credential'
  );

  const updated = await member.request(`/api/vault/credentials/${credentialId}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: `${runId} credential updated`,
      loginUsername: `${runId}_login`,
      password: `${password}_vault_updated`,
      category: `${runId}_project`,
      tags: [runId, 'updated'],
      url: 'https://example.com/login',
      notes: 'updated by user scenario smoke'
    })
  });
  assertStatus(updated, 200, 'member updates own vault credential');
  const updatedSecret = await member.request(`/api/vault/credentials/${credentialId}/secret`);
  assert(updatedSecret.payload.secret?.password === `${password}_vault_updated`, 'updated vault secret mismatch');

  assertStatus(await member.request(`/api/vault/credentials/${credentialId}`, { method: 'DELETE' }), 200, 'member deletes own vault credential');
  assertStatus(await member.request(`/api/vault/credentials/${credentialId}/secret`), 404, 'deleted vault secret missing');
}

async function testWorkspaceThemeIsolation({ users }) {
  const member = new TestClient('member-theme');
  await member.login(users.member.username);
  const assigned = new TestClient('assigned-theme');
  await assigned.login(users.assigned.username);

  const theme = {
    mode: 'gradient',
    solidColor: '#101010',
    gradientStart: '#101010',
    gradientEnd: '#21514a',
    gradientAngle: 127,
    imageUrl: '',
    overlay: 33
  };
  const updated = await member.request('/api/user/workspace-theme', {
    method: 'PUT',
    body: JSON.stringify({ theme })
  });
  assertStatus(updated, 200, 'member theme update');
  assert(updated.payload.theme?.gradientEnd === theme.gradientEnd, 'member theme update mismatch');

  const ownTheme = await member.request('/api/user/workspace-theme');
  assert(ownTheme.payload.theme?.gradientEnd === theme.gradientEnd, 'member theme read mismatch');

  const otherTheme = await assigned.request('/api/user/workspace-theme');
  assert(otherTheme.payload.theme?.gradientEnd !== theme.gradientEnd, 'workspace theme should be isolated per user');
}

async function testBackgroundUpload({ users }) {
  const member = new TestClient('member-background');
  await member.login(users.member.username);
  const upload = await member.request('/api/user/workspace-theme/background', {
    method: 'POST',
    body: JSON.stringify({
      mimeType: 'image/png',
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    })
  });
  assertStatus(upload, 201, 'background upload');
  const imageUrl = upload.payload.image?.imageUrl;
  assert(imageUrl, 'background upload should return imageUrl');
  uploadedFiles.push(imageUrl);
  assertStatus(await member.request(imageUrl), 200, 'uploaded background public fetch');
}

async function testAdminPermissions({ users }) {
  const member = new TestClient('member-admin');
  await member.login(users.member.username);
  assertStatus(await member.request('/api/admin/users'), 403, 'member admin users blocked');
  assertStatus(await member.request('/api/admin/groups'), 403, 'member admin groups blocked');

  const admin = new TestClient('admin-api');
  await admin.login(users.admin.username);
  assertStatus(await admin.request('/api/admin/users'), 200, 'admin list users');
  const groups = await admin.request('/api/admin/groups');
  assertStatus(groups, 200, 'admin list groups');
  const smokeGroup = (groups.payload.groups || []).find((group) => group.name === `${runId}_group`);
  const smokeSite = smokeGroup?.sites?.find((site) => site.name === `${runId}_users`);
  assert(smokeSite?.visibility === 'users', 'admin groups should include site permission fields');

  const created = await admin.request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: `${runId}_created_by_admin`,
      nick: `${runId}_created_by_admin`,
      password,
      role: 'member',
      status: 'active'
    })
  });
  assertStatus(created, 201, 'admin creates user');
  const createdUserId = created.payload.user?.id;
  assert(created.payload.user?.mustChangePassword === true, 'admin-created user should require first password change');
  if (createdUserId) {
    createdUserIds.push(createdUserId);
  }

  assertStatus(
    await admin.request(`/api/admin/users/${createdUserId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: `${password}Reset` })
    }),
    200,
    'admin resets password'
  );

  assertStatus(
    await admin.request(`/api/admin/users/${createdUserId}`, {
      method: 'PUT',
      body: JSON.stringify({ nick: `${runId}_disabled_by_admin`, role: 'member', status: 'disabled' })
    }),
    200,
    'admin updates user'
  );

  assertStatus(await admin.request(`/api/admin/users/${createdUserId}`, { method: 'DELETE' }), 200, 'admin deletes user');
}

async function testDingTalkConfigEndpoint() {
  const client = new TestClient('dingtalk-config');
  const result = await client.request('/api/auth/dingtalk/url');
  assertStatus(result, 200, 'dingtalk url endpoint');
  assert(result.payload.ok === true, 'dingtalk url endpoint should return ok envelope');
  assert(typeof result.payload.configured === 'boolean', 'dingtalk url endpoint should expose configured boolean');

  const invalidHandoff = await client.request('/api/auth/handoff-login', {
    method: 'POST',
    body: JSON.stringify({ token: 'invalid-handoff-token' })
  });
  assertStatus(invalidHandoff, 401, 'invalid DingTalk handoff should be rejected');

  const localhostResult = await client.request('/api/auth/dingtalk/url', {
    headers: { origin: 'http://localhost:2223' }
  });
  assertStatus(localhostResult, 200, 'dingtalk url endpoint with localhost origin');
  if (!localhostResult.payload.configured) {
    return;
  }

  const authUrl = new URL(localhostResult.payload.authUrl);
  const fullPageAuthUrl = new URL(localhostResult.payload.fullPageAuthUrl);
  assert(
    authUrl.searchParams.get('prompt') === 'consent',
    'dingtalk auth url should request consent for delegated profile scope'
  );
  assert(authUrl.searchParams.get('iframe') === 'true', 'dingtalk auth url should use iframe flow');
  const scope = authUrl.searchParams.get('scope') || '';
  const scopeParts = scope.split(/\s+/);
  assert(scopeParts.includes('openid'), 'dingtalk auth scope should include openid');
  assert(scopeParts.includes('Contact.User.Read'), 'dingtalk login should request Contact.User.Read');
  if (authUrl.searchParams.has('corpId')) {
    assert(scopeParts.includes('corpid'), 'dingtalk auth scope should include corpid when corpId is sent');
  }
  assert(localhostResult.payload.fullPageAuthUrl, 'dingtalk url endpoint should expose fullPageAuthUrl');
  assert(
    authUrl.searchParams.get('state') === fullPageAuthUrl.searchParams.get('state'),
    'dingtalk iframe and full page urls should share one state'
  );
  const fullPageScope = fullPageAuthUrl.searchParams.get('scope') || '';
  assert(
    fullPageScope.split(/\s+/).includes('Contact.User.Read'),
    'dingtalk full page login should request Contact.User.Read'
  );
  assert(
    fullPageAuthUrl.searchParams.get('prompt') === 'consent',
    'dingtalk full page login should request consent for delegated profile scope'
  );
  const state = authUrl.searchParams.get('state');
  assert(state, 'dingtalk auth url should include state');
  const statePayload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf8'));
  assert(
    statePayload.frontendOrigin === 'http://localhost:2223',
    `dingtalk state should remember localhost origin, got ${statePayload.frontendOrigin}`
  );

  const callbackResponse = await fetch(`${baseUrl}/api/auth/dingtalk/callback?state=${encodeURIComponent(state)}`, {
    redirect: 'manual'
  });
  const callbackHtml = await callbackResponse.text();
  assert(callbackResponse.status === 200, `dingtalk callback should return handoff html, got ${callbackResponse.status}`);
  assert(
    callbackHtml.includes('http://localhost:2223/login.html?error='),
    'dingtalk callback should return to the origin stored in state'
  );
}

async function visibleSmokeSiteNames(client) {
  const response = await client.request('/api/nav/groups');
  assertStatus(response, 200, `${client.label} nav groups`);
  return (response.payload.groups || [])
    .flatMap((group) => group.sites || [])
    .map((site) => site.name)
    .filter((name) => name.startsWith(runId))
    .sort();
}

async function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await Promise.race([once(serverProcess, 'exit'), wait(2000)]).catch(() => {});
  }

  for (const imageUrl of uploadedFiles) {
    const match = imageUrl.match(/^\/uploads\/workspace-backgrounds\/(\d+)\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      await fs.rm(path.join(workspaceBackgroundRoot, match[1], match[2]), { force: true }).catch(() => {});
    }
  }

  if (createdGroupId) {
    await db.query('DELETE FROM nav_groups WHERE id = ?', [createdGroupId]).catch(() => {});
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

function assertSet(actual, expected, label) {
  const actualText = JSON.stringify([...actual].sort());
  const expectedText = JSON.stringify([...expected].sort());
  assert(actualText === expectedText, `${label}: expected ${expectedText}, got ${actualText}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
