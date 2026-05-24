# 汐航代码规范化重构步骤

本文件是安全重构方案，不是立即执行脚本。目标是在不改变数据库结构、不替换 SQL、不改变 session 存储机制、不破坏现有 API 行为的前提下，逐步把代码组织得更清晰。

重要现状：

- 项目 `package.json` 使用 `"type": "module"`，示例代码统一使用 `import/export`，不要改成 CommonJS `require`。
- 当前后端入口是 `backend/src/server.js`，且已包含 Express、session、钉钉、SSO、Vault、Admin 等逻辑。
- 当前已经存在 `requireLogin`、`requireAdmin`、统一错误处理中间件、钉钉 state 校验、生产环境 `secure` cookie 等基础安全能力。重构重点是拆分文件和规范边界，不是重写业务。
- 前端已经有 `frontend/src/api.js` 和外置页面脚本，后续规范化应做增量拆分，不能大面积重写 UI。

## 0. 建立基线

操作：

1. 建立独立分支。
2. 记录当前工作区状态。
3. 跑通已有检查和测试。
4. 重构后重复同样命令对比。

命令：

```powershell
git status --short
git switch -c chore/project-cleanup-refactor
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
node scripts\verify-after-refactor.mjs
```

风险等级：低

回滚方案：

```powershell
git switch -
```

如果已经在重构分支提交：

```powershell
git revert <commit>
```

不要使用 `git reset --hard`，除非已经确认不会丢失本地修改。

## 1. 后端目录结构重组

操作：

不要第一步就移动 `backend/src/server.js`，因为 `package.json` 当前脚本直接启动它：

```json
"dev:backend": "node --watch backend/src/server.js",
"start": "node backend/src/server.js"
```

建议先在 `backend/src/` 下建立分层目录，保持入口文件名不变：

```text
backend/src/
├── server.js                  # 启动入口，最后只负责 initDatabase + listen
├── app.js                     # 创建 Express app，注册中间件和路由
├── routes/
│   ├── auth.routes.js
│   ├── nav.routes.js
│   ├── vault.routes.js
│   ├── admin.routes.js
│   └── sso.routes.js
├── controllers/
│   ├── auth.controller.js
│   ├── nav.controller.js
│   ├── vault.controller.js
│   ├── admin.controller.js
│   └── sso.controller.js
├── services/
│   ├── dingtalk.service.js
│   ├── sso.service.js
│   └── workspace.service.js
├── middlewares/
│   ├── authGuard.js
│   ├── adminGuard.js
│   ├── asyncHandler.js
│   ├── errorHandler.js
│   └── rateLimit.js
├── utils/
│   ├── crypto.js
│   ├── dingtalkLog.js
│   └── url.js
└── config/
    └── env.js
```

等第一轮拆分稳定后，如果确实需要用户要求中的 `backend/app.js`，再新增一个兼容出口，不要删除 `backend/src/server.js`。

代码改动示例：

```js
// backend/src/app.js
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import session from 'express-session';
import { config } from './config/env.js';
import { MySqlSessionStore } from './mysql-session-store.js';
import { getPool } from './db.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createNavRouter } from './routes/nav.routes.js';
import { createVaultRouter } from './routes/vault.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { createSsoRouter } from './routes/sso.routes.js';
import { errorHandler } from './middlewares/errorHandler.js';

export function createApp() {
  const app = express();
  const sessionStore = new MySqlSessionStore(() => getPool());

  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '8mb' }));
  app.use(session({
    name: 'tidesail_sid',
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 1000 * 60 * 60 * 8
    }
  }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', createAuthRouter());
  app.use('/api/nav', createNavRouter());
  app.use('/api/vault', createVaultRouter());
  app.use('/api/admin', createAdminRouter());
  app.use('/api/sso', createSsoRouter());
  app.use(errorHandler);

  return { app, sessionStore };
}
```

```js
// backend/src/server.js
import dns from 'node:dns';
import { createApp } from './app.js';
import { config, validateEnv } from './config/env.js';
import { initDatabase } from './db.js';

validateEnv();

if (process.env.DINGTALK_FORCE_IPV4 !== 'false') {
  dns.setDefaultResultOrder('ipv4first');
}

initDatabase()
  .then(() => {
    const { app } = createApp();
    app.listen(config.port, () => {
      console.log(`汐航 API is running at http://localhost:${config.port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error.message);
    process.exit(1);
  });
```

风险等级：中

回滚方案：

- 保留原 `backend/src/server.js` 直到所有测试通过。
- 每拆出一个路由文件就提交一次。
- 如某一步失败，直接恢复该文件：

```powershell
git restore -- backend/src/server.js backend/src/app.js backend/src/routes
```

验证方法：

```powershell
npm.cmd run check
npm.cmd run test:user-scenarios
node scripts\verify-after-refactor.mjs
```

## 2. 统一环境变量读取和校验

操作：

保持 `dotenv`，但集中到 `backend/src/config/env.js`。不要在多个文件反复 `dotenv.config()`。

代码改动示例：

```js
// backend/src/config/env.js
import dotenv from 'dotenv';

dotenv.config();

function parseList(value = '') {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 2222),
  frontendOrigins: parseList(process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:2223,http://localhost:2223'),
  sessionSecret: process.env.SESSION_SECRET || '',
  vaultEncryptionKey: process.env.VAULT_ENCRYPTION_KEY || '',
  mysql: {
    host: process.env.MYSQL_HOST || '',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || ''
  },
  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_APP_ID || '',
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || process.env.DINGTALK_APP_SECRET || '',
    corpId: process.env.DINGTALK_CORP_ID || '',
    redirectUri: process.env.DINGTALK_REDIRECT_URI || '',
    scope: process.env.DINGTALK_OAUTH_SCOPE || 'openid corpid Contact.User.Read',
    prompt: process.env.DINGTALK_OAUTH_PROMPT || 'consent'
  }
};

export function validateEnv() {
  const required = [
    ['MYSQL_HOST', config.mysql.host],
    ['MYSQL_USER', config.mysql.user],
    ['MYSQL_DATABASE', config.mysql.database],
    ['SESSION_SECRET', config.sessionSecret],
    ['VAULT_ENCRYPTION_KEY', config.vaultEncryptionKey]
  ];

  const missing = required.filter(([, value]) => !String(value || '').trim()).map(([key]) => key);

  if (missing.length > 0) {
    console.error(`[env] 缺少必要环境变量: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (config.isProduction && config.sessionSecret.length < 32) {
    console.error('[env] 生产环境 SESSION_SECRET 长度建议不少于 32 位。');
    process.exit(1);
  }

  if (config.isProduction && config.vaultEncryptionKey.length < 32) {
    console.error('[env] 生产环境 VAULT_ENCRYPTION_KEY 长度建议不少于 32 位。');
    process.exit(1);
  }

  const dingtalkPartiallyConfigured =
    config.dingtalk.clientId || config.dingtalk.clientSecret || config.dingtalk.redirectUri;
  const dingtalkComplete =
    config.dingtalk.clientId && config.dingtalk.clientSecret && config.dingtalk.redirectUri;

  if (dingtalkPartiallyConfigured && !dingtalkComplete) {
    console.error('[env] 钉钉配置不完整，需要同时配置 DINGTALK_CLIENT_ID、DINGTALK_CLIENT_SECRET、DINGTALK_REDIRECT_URI。');
    process.exit(1);
  }
}
```

风险等级：中

回滚方案：

```powershell
git restore -- backend/src/config/env.js backend/src/server.js backend/src/app.js
```

验证方法：

```powershell
node --check backend/src/config/env.js
npm.cmd run test:user-scenarios
```

注意：

- 开发环境可以允许钉钉完全不配置，但不建议允许“配置一半”。
- 不要在校验函数里打印密钥值。

## 3. 统一异步错误处理

操作：

当前项目已经有末尾错误处理中间件。重构时建议把它移动到独立文件，并用 `asyncHandler` 消除重复 try/catch。

代码改动示例：

```js
// backend/src/middlewares/asyncHandler.js
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
```

```js
// backend/src/middlewares/errorHandler.js
export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = Number(error.status || error.statusCode || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = error.message || '服务异常。';

  res.status(safeStatus).json({
    ok: false,
    error: message,
    message
  });
}
```

路由中使用：

```js
// backend/src/routes/nav.routes.js
import { Router } from 'express';
import { requireLogin } from '../middlewares/authGuard.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { getSiteGroupsForUser } from '../db.js';

export function createNavRouter() {
  const router = Router();

  router.get('/groups', requireLogin, asyncHandler(async (req, res) => {
    const groups = await getSiteGroupsForUser(req.session.user);
    res.json({ ok: true, groups });
  }));

  return router;
}
```

风险等级：中

回滚方案：

```powershell
git restore -- backend/src/middlewares/errorHandler.js backend/src/middlewares/asyncHandler.js backend/src/routes
```

验证方法：

- 未登录请求 `/api/nav/groups` 仍返回 401。
- 普通成员请求 `/api/admin/overview` 仍返回 403。
- 业务错误仍返回 JSON，不返回 HTML。

```powershell
node scripts\verify-after-refactor.mjs
```

## 4. 鉴权和管理员中间件分层

操作：

当前 `requireLogin` 和 `requireAdmin` 已在 `server.js` 内实现。重构时移动到 `backend/src/middlewares/authGuard.js` 和 `adminGuard.js`，行为保持不变。

代码改动示例：

```js
// backend/src/middlewares/authGuard.js
import { findUserById } from '../db.js';
import { sessionUserFromDb } from '../utils/sessionUser.js';

export async function requireLogin(req, res, next) {
  try {
    if (!req.session.user) {
      res.status(401).json({ ok: false, message: '请先登录。' });
      return;
    }

    const currentUser = await findUserById(req.session.user.id);
    if (!currentUser || currentUser.status === 'disabled') {
      req.session.destroy(() => {});
      res.status(401).json({ ok: false, message: '账号已被禁用，请联系管理员。' });
      return;
    }

    req.session.user = sessionUserFromDb(currentUser);
    if (currentUser.mustChangePassword && req.path !== '/change-password') {
      res.status(403).json({
        ok: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: '首次登录必须修改密码。'
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}
```

```js
// backend/src/middlewares/adminGuard.js
export function adminGuard(req, res, next) {
  if (req.session.user?.role === 'admin') {
    next();
    return;
  }

  res.status(403).json({ ok: false, message: '没有后台权限。' });
}
```

管理路由统一挂载：

```js
// backend/src/routes/admin.routes.js
import { Router } from 'express';
import { requireLogin } from '../middlewares/authGuard.js';
import { adminGuard } from '../middlewares/adminGuard.js';

export function createAdminRouter(controller) {
  const router = Router();

  router.use(requireLogin, adminGuard);
  router.get('/overview', controller.overview);
  router.get('/users', controller.listUsers);
  router.post('/users', controller.createUser);
  router.put('/users/:id', controller.updateUser);
  router.delete('/users/:id', controller.deleteUser);
  router.post('/users/:id/reset-password', controller.resetPassword);
  router.get('/groups', controller.listGroups);
  router.put('/groups', controller.saveGroups);
  router.get('/settings', controller.getSettings);
  router.put('/settings', controller.saveSettings);
  router.get('/audit-logs', controller.auditLogs);
  router.get('/backup', controller.backup);

  return router;
}
```

风险等级：中

回滚方案：

```powershell
git restore -- backend/src/server.js backend/src/routes/admin.routes.js backend/src/middlewares
```

验证方法：

```powershell
node scripts\verify-after-refactor.mjs
```

并手动确认：

- 未登录访问 `/api/admin/overview` 是 401。
- 普通成员访问 `/api/admin/overview` 是 403。
- 管理员访问 `/api/admin/overview` 是 200。

## 5. 钉钉服务拆分

操作：

钉钉相关函数较多，建议移动到 `backend/src/services/dingtalk.service.js`，但保持接口参数和返回结构不变。

代码改动示例：

```js
// backend/src/services/dingtalk.service.js
import crypto from 'node:crypto';
import { config } from '../config/env.js';

const PROFILE_SCOPE = 'Contact.User.Read';

export function createDingTalkAuthUrl({ state, mode = 'page' }) {
  const loginUrl = new URL('https://login.dingtalk.com/oauth2/auth');
  const scope = getDingTalkOAuthScope();

  loginUrl.searchParams.set('client_id', config.dingtalk.clientId);
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('scope', scope);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('redirect_uri', config.dingtalk.redirectUri);

  if (mode === 'iframe') {
    loginUrl.searchParams.set('iframe', 'true');
    loginUrl.searchParams.set('FEShowIframeTips', 'true');
  }

  if (config.dingtalk.prompt || scopeIncludes(scope, PROFILE_SCOPE)) {
    loginUrl.searchParams.set('prompt', config.dingtalk.prompt || 'consent');
  }

  if (config.dingtalk.corpId && scopeIncludes(scope, 'corpid')) {
    loginUrl.searchParams.set('corpId', config.dingtalk.corpId);
  }

  return loginUrl.toString();
}

export function createState(payload, secret) {
  const statePayload = Buffer.from(JSON.stringify({
    nonce: crypto.randomBytes(18).toString('hex'),
    timestamp: Date.now(),
    ...payload
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(statePayload).digest('base64url');
  return `${statePayload}.${signature}`;
}

export function verifyState(state, secret, maxAgeMs = 10 * 60 * 1000) {
  const [payload, signature] = String(state || '').split('.');
  if (!payload || !signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return Date.now() - Number(parsed.timestamp || 0) <= maxAgeMs;
}

function getDingTalkOAuthScope() {
  const scopes = new Set(String(config.dingtalk.scope || '').split(/\s+/).filter(Boolean));
  scopes.add('openid');
  if (config.dingtalk.corpId) scopes.add('corpid');
  scopes.add(PROFILE_SCOPE);
  return [...scopes].join(' ');
}

function scopeIncludes(scope, target) {
  return String(scope || '')
    .split(/\s+/)
    .some((item) => item.toLowerCase() === String(target || '').toLowerCase());
}
```

风险等级：高

原因：

- 钉钉 OAuth、state、iframe 回调、handoff token 多处联动。
- 最近问题集中在该模块，拆分时不能顺手改变参数。

回滚方案：

```powershell
git restore -- backend/src/server.js backend/src/services/dingtalk.service.js backend/src/routes/auth.routes.js
```

验证方法：

- `/api/auth/dingtalk/url` 生成的 `scope`、`prompt`、`corpId`、`redirect_uri` 与重构前一致。
- 扫码能回调，并出现 `callback.received`。
- 成功后能通过 `auth_handoff` 登录。

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:2222/api/auth/dingtalk/url -Headers @{ Origin='http://127.0.0.1:2223' } | ConvertTo-Json -Depth 10
Get-Content -Encoding UTF8 -Wait -Tail 80 data\dingtalk-events.ndjson
```

## 6. SSO 和 Vault 拆分

操作：

只移动代码，不改 SQL、不改表结构、不改加密格式。

SSO 建议拆到：

```text
backend/src/routes/sso.routes.js
backend/src/controllers/sso.controller.js
backend/src/services/sso.service.js
```

Vault 建议拆到：

```text
backend/src/routes/vault.routes.js
backend/src/controllers/vault.controller.js
backend/src/services/vault.service.js
```

代码改动示例：

```js
// backend/src/routes/vault.routes.js
import { Router } from 'express';
import { requireLogin } from '../middlewares/authGuard.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';

export function createVaultRouter(controller) {
  const router = Router();

  router.use(requireLogin);
  router.get('/credentials', asyncHandler(controller.listCredentials));
  router.post('/credentials', asyncHandler(controller.createCredential));
  router.put('/credentials/:id', asyncHandler(controller.updateCredential));
  router.delete('/credentials/:id', asyncHandler(controller.deleteCredential));
  router.get('/credentials/:id/secret', asyncHandler(controller.getCredentialSecret));

  return router;
}
```

```js
// backend/src/controllers/vault.controller.js
export function createVaultController({
  listPersonalCredentials,
  createPersonalCredential,
  updatePersonalCredential,
  deletePersonalCredential,
  getPersonalCredentialSecret
}) {
  return {
    async listCredentials(req, res) {
      res.json({ ok: true, credentials: await listPersonalCredentials(req.session.user.id) });
    },
    async createCredential(req, res) {
      const credential = await createPersonalCredential(req.session.user.id, req.body);
      res.status(201).json({ ok: true, credential });
    },
    async updateCredential(req, res) {
      const credential = await updatePersonalCredential(req.session.user.id, req.params.id, req.body);
      res.json({ ok: true, credential });
    },
    async deleteCredential(req, res) {
      await deletePersonalCredential(req.session.user.id, req.params.id);
      res.json({ ok: true });
    },
    async getCredentialSecret(req, res) {
      const secret = await getPersonalCredentialSecret(req.session.user.id, req.params.id);
      res.json({ ok: true, secret });
    }
  };
}
```

风险等级：中

回滚方案：

```powershell
git restore -- backend/src/server.js backend/src/routes/vault.routes.js backend/src/controllers/vault.controller.js
```

验证方法：

- 登录后星钥库列表仍只显示本人数据。
- 显示密码仍需要单独请求 `/api/vault/credentials/:id/secret`。
- `npm.cmd run test:user-scenarios` 中的“星钥库个人隔离”必须通过。

## 7. 前端 API 模块规范化

操作：

当前已有 `frontend/src/api.js`，建议在不破坏现有调用的基础上扩展具名方法。统一错误处理时不要强制所有错误都 `alert`，否则会影响页面自己的错误展示。建议支持可选 `silent`。

代码改动示例：

```js
// frontend/src/api.js
import { API_BASE_URL } from './config.js';

export async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const message = payload.message || payload.error || '请求失败';
    const error = new Error(message);
    error.status = response.status;
    error.code = payload.code;

    if (!options.silent && options.notify !== false) {
      window.dispatchEvent(new CustomEvent('xihang:api-error', { detail: { message, status: response.status } }));
    }

    throw error;
  }

  return payload;
}

export function login(username, password) {
  return api('/api/auth/password-login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    notify: false
  });
}

export function getMe() {
  return api('/api/auth/me', { silent: true });
}

export function logout() {
  return api('/api/auth/logout', { method: 'POST', body: '{}' });
}

export function getNavGroups() {
  return api('/api/nav/groups');
}

export function getVaultCredentials() {
  return api('/api/vault/credentials');
}

export function getWorkspaceTheme() {
  return api('/api/user/workspace-theme');
}

export function getAdminOverview() {
  return api('/api/admin/overview');
}
```

页面级错误监听：

```js
window.addEventListener('xihang:api-error', (event) => {
  const message = event.detail?.message || '请求失败';
  console.warn('[api]', message);
});
```

风险等级：低

回滚方案：

```powershell
git restore -- frontend/src/api.js
```

验证方法：

```powershell
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
```

## 8. 前端共用样式提取

操作：

当前主样式已经移动到 `frontend/src/styles/styles.css`。不要一次拆成很多文件；后续如需继续提取共用样式，建议先创建 `frontend/src/styles/global.css`，再由 `styles.css` 引入，保持 HTML 统一引用 `/src/styles/styles.css`。

代码改动示例：

```css
/* frontend/src/styles/global.css */
:root {
  --xihang-bg: #f6f8fb;
  --xihang-panel: rgba(255, 255, 255, 0.92);
  --xihang-border: rgba(31, 41, 55, 0.1);
  --xihang-text: #111827;
  --xihang-muted: #6b7280;
  --xihang-primary: #2563eb;
}

.glass-panel {
  background: var(--xihang-panel);
  border: 1px solid var(--xihang-border);
  box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(18px);
}

.form-input {
  width: 100%;
  border: 1px solid var(--xihang-border);
  background: #fff;
  color: var(--xihang-text);
}
```

```css
/* frontend/src/styles/styles.css */
@import './global.css';

/* 保留原有页面样式，逐步向 global.css 收敛 */
```

风险等级：低

回滚方案：

```powershell
git restore -- frontend/src/styles/styles.css frontend/src/styles/global.css
```

验证方法：

```powershell
npm.cmd run build:frontend
```

并用浏览器检查：

```text
http://127.0.0.1:2223/login.html
http://127.0.0.1:2223/
http://127.0.0.1:2223/admin.html
http://127.0.0.1:2223/vault.html
```

## 9. 页面脚本规范化示例

操作：

当前 `login.html` 已经通过 `<script type="module" src="/src/pages/login.js">` 引入外部脚本，不是大段内联 JS。后续页面脚本应继续统一放到 `frontend/src/pages/`。

如果后续还需要兼容旧路径，可以临时保留旧入口文件，让它只做转发：

```js
// frontend/src/login.js
import './pages/login.js';
```

然后把原内容移动到：

```js
// frontend/src/pages/login.js
import { login, getMe, api } from '../api.js';

// 原 frontend/src/login.js 的页面逻辑迁移到这里
// 保持 DOM id、事件名、钉钉 postMessage、auth_handoff 处理逻辑不变
```

最后再把 HTML 改为：

```html
<script type="module" src="/src/pages/login.js?v=20260524-refactor1"></script>
```

注意：

- 不能删除密码登录逻辑。
- 不能删除钉钉 iframe 和 `auth_handoff` 逻辑。
- 当前项目没有公开注册入口，不要新增“注册”行为。
- 如果后续要做忘记密码，必须先设计后台重置或邮件流程，不能在这次规范化中顺手添加。

风险等级：中

回滚方案：

```powershell
git restore -- frontend/login.html frontend/src/login.js frontend/src/pages/login.js
```

验证方法：

```powershell
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
```

并手动验证：

- 密码登录成功跳转。
- 首次登录跳转改密。
- 钉钉二维码展示。
- 钉钉扫码回调后能进入工作台。
- 登录页前端事件检测仍能记录。

## 10. ESLint 和 Prettier

操作：

先只安装和检查，不要立即 `--fix`。首次格式化前必须提交当前代码或打补丁备份。

安装命令：

```powershell
npm install -D eslint prettier eslint-config-standard eslint-plugin-import eslint-plugin-n eslint-plugin-promise globals
```

`package.json` 增加：

```json
{
  "scripts": {
    "lint": "eslint backend frontend scripts --ext .js,.mjs",
    "format": "prettier --check \"**/*.{js,mjs,css,html,md,json}\"",
    "format:write": "prettier --write \"**/*.{js,mjs,css,html,md,json}\""
  }
}
```

`.eslintrc.js` 示例：

```js
export default {
  root: true,
  env: {
    browser: true,
    node: true,
    es2024: true
  },
  extends: ['standard'],
  globals: {
    process: 'readonly'
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    'no-console': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'import/extensions': 'off',
    'n/no-unsupported-features/es-syntax': 'off'
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'data/uploads/',
    '*.log'
  ]
};
```

说明：本项目是 `"type": "module"`。如果当前 ESLint 版本无法加载 `.eslintrc.js`，把文件名改为 `.eslintrc.cjs` 并改用 `module.exports = { ... }`，不要为配置文件去改整个项目的模块类型。

`.prettierrc` 示例：

```json
{
  "printWidth": 120,
  "singleQuote": true,
  "semi": true,
  "trailingComma": "none",
  "arrowParens": "always",
  "endOfLine": "auto"
}
```

首次检查：

```powershell
npm.cmd run lint
npm.cmd run format
```

谨慎自动修复：

```powershell
git status --short
npm.cmd run lint -- --fix
npm.cmd run format:write
npm.cmd run test:user-scenarios
```

风险等级：中

回滚方案：

```powershell
git restore -- package.json package-lock.json .eslintrc.js .prettierrc
```

如果已经自动格式化很多文件：

```powershell
git diff --stat
git restore -- backend frontend scripts
```

## 11. 最终验收清单

每完成一个重构阶段，都执行：

```powershell
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
node scripts\verify-after-refactor.mjs
```

人工验证：

- 管理员密码登录进入后台。
- 普通成员不能进入后台。
- 管理员创建用户后，该用户首次登录必须改密码。
- 工作台只展示当前用户有权限访问的站点。
- 星钥库只能看到自己的记录。
- 工作台背景色、渐变和上传图片能保存。
- 钉钉 URL 包含 `scope=openid corpid Contact.User.Read` 和 `prompt=consent`。
- 钉钉扫码成功后能跳转。
- `/api/sso/authorize` 对未授权站点不签发 ticket。

禁止事项：

- 禁止引入 ORM 替换现有 SQL。
- 禁止修改数据库表结构，除非单独出迁移方案并备份。
- 禁止修改 session 存储机制。
- 禁止把 `.env`、钉钉密钥、数据库密码写入文档或提交。
- 禁止在同一提交里同时做大规模 UI 改版和后端结构拆分。
