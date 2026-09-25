import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import {
  changeOwnPassword,
  cleanExpiredSsoTickets,
  consumeSsoTicket,
  createAdminBackupSnapshot,
  createLocalUser,
  createPersonalCredential,
  createProject,
  createSsoTicket,
  deletePersonalCredential,
  deleteProject,
  deleteUser,
  disableStaleDingTalkUsers,
  findUserByDingTalkUserId,
  findUserById,
  findUserByUsername,
  getAdminOverview,
  getDecryptedSystemSetting,
  getPool,
  getPersonalCredentialSecret,
  getSiteGroups,
  getSiteGroupsForUser,
  getUserHomeLayout,
  getUserWorkspaceTheme,
  initDatabase,
  listAuditLogs,
  listDingTalkDocs,
  listPersonalCredentials,
  listProjects,
  listSystemSettings,
  listUsers,
  replaceDingTalkDocs,
  replaceSiteGroups,
  recordAuditLog,
  resetUserPassword,
  touchUserLogin,
  updatePersonalCredential,
  updateProject,
  updateSystemSettings,
  updateUserHomeLayout,
  updateUserWorkspaceTheme,
  updateUser,
  upsertDingTalkUser,
  upsertRosterUser
} from './db.js';
import { MySqlSessionStore } from './mysql-session-store.js';
import { createCostRouter } from './cost-ledger.js';
import { createDashboardRouter } from './dashboard.js';
import { syncDingTalkRoster } from './dingtalk-roster.js';
import { syncDingTalkWiki } from './dingtalk-wiki.js';

dotenv.config();

if (process.env.DINGTALK_FORCE_IPV4 !== 'false') {
  dns.setDefaultResultOrder('ipv4first');
}

// Warning only, never a hard exit here: session cookies, the DingTalk login
// state/handoff signatures, and the vault/system-secret encryption key all
// derive from these two values. Left at the built-in fallback, anyone who
// has read this source file can forge them.
if (!process.env.SESSION_SECRET) {
  console.warn('[security] 未配置 SESSION_SECRET，正在使用内置默认值——session、钉钉登录跳转签名都可能被伪造，请在 .env 里设置一个长随机值。');
}
if (!process.env.VAULT_ENCRYPTION_KEY && !process.env.SESSION_SECRET) {
  console.warn('[security] 未配置 VAULT_ENCRYPTION_KEY，星钥库和系统密钥的加密正在使用内置默认密钥，请在 .env 里单独设置一个长随机值。');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');
const workspaceBackgroundRoot = path.join(rootDir, 'data', 'uploads', 'backgrounds');
const dingTalkEventLogPath = path.join(rootDir, 'data', 'dingtalk-events.ndjson');
const app = express();
const port = Number(process.env.PORT || 2222);
const frontendOrigins = parseList(process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:2223,http://localhost:2223');
const frontendOrigin = frontendOrigins[0];
const redirectUri = process.env.DINGTALK_REDIRECT_URI || `http://127.0.0.1:${port}/api/auth/dingtalk/callback`;
const allowedUnionIds = parseList(process.env.ALLOWED_DINGTALK_UNION_IDS);
const adminUnionIds = parseList(process.env.ADMIN_DINGTALK_UNION_IDS);
const adminNicks = parseList(process.env.ADMIN_DINGTALK_NICKS || 'admin').map((item) => item.toLowerCase());
const ssoTicketTtlSeconds = Number(process.env.SSO_TICKET_TTL_SECONDS || 120);
const dingTalkProfileScope = 'Contact.User.Read';
const sessionStore = new MySqlSessionStore(() => getPool());
const rateLimitBuckets = new Map();
let dingTalkAppAccessTokenCache = null;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedFrontendOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '8mb' }));
app.use(
  session({
    name: 'tidesail_sid',
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use('/api/admin/costs', createCostRouter({ db: getPool(), requireLogin, requireAdmin, writeAudit }));
app.use('/api/admin/dashboard', createDashboardRouter({ db: getPool(), requireLogin, requireAdmin, listProjects }));

setInterval(pruneRateLimitBuckets, 1000 * 60).unref();
setInterval(() => {
  sessionStore.clearExpired().catch((error) => {
    console.error('Failed to clean expired sessions:', error.message);
  });
}, 1000 * 60 * 60).unref();

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/uploads/workspace-backgrounds/:userId/:fileName', async (req, res, next) => {
  try {
    const userId = parsePositiveId(req.params.userId);
    const fileName = String(req.params.fileName || '');
    if (!userId || !/^[A-Za-z0-9_.-]+$/.test(fileName)) {
      res.status(400).json({ ok: false, message: '背景图片地址无效。' });
      return;
    }

    const filePath = path.join(workspaceBackgroundRoot, String(userId), fileName);
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ ok: false, message: '背景图片不存在。' });
      return;
    }
    next(error);
  }
});

app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (!req.session.user) {
      res.json({ ok: true, user: null, loginUrl: dingtalkLoginUrl(req) });
      return;
    }

    const currentUser = await findUserById(req.session.user.id);
    if (!currentUser || currentUser.status === 'disabled') {
      req.session.destroy(() => {});
      res.json({ ok: true, user: null, loginUrl: dingtalkLoginUrl(req) });
      return;
    }

    req.session.user = sessionUserFromDb(currentUser);
    res.json({ ok: true, user: safeUser(req.session.user), loginUrl: dingtalkLoginUrl(req) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/dingtalk', (req, res) => {
  try {
    assertDingTalkConfig();
    res.redirect(createDingTalkAuthUrl(req, { mode: 'page' }));
  } catch (error) {
    res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent(error.message)}`);
  }
});

app.get('/api/auth/dingtalk/url', (req, res) => {
  try {
    assertDingTalkConfig();
    const sharedState = createState(req);
    const authUrl = createDingTalkAuthUrl(req, { mode: 'iframe', state: sharedState });
    const fullPageAuthUrl = createDingTalkAuthUrl(req, { mode: 'page', state: sharedState });
    logDingTalkEvent('auth-url.created', {
      redirectUri,
      hasCorpId: Boolean(process.env.DINGTALK_CORP_ID),
      scope: getDingTalkOAuthScope(),
      hasProfileScope: dingTalkScopeIncludes(getDingTalkOAuthScope(), dingTalkProfileScope),
      sendsCorpId: new URL(authUrl).searchParams.has('corpId'),
      orgType: new URL(authUrl).searchParams.get('org_type') || '',
      prompt: new URL(authUrl).searchParams.get('prompt') || '',
      iframeTips: new URL(authUrl).searchParams.get('FEShowIframeTips') || '',
      origin: req.get('origin') || '',
      host: req.get('host') || '',
      frameOrigin: new URL(redirectUri).origin
    });
    res.json({
      ok: true,
      configured: true,
      authUrl,
      fullPageAuthUrl,
      loginUrl: dingtalkLoginUrl(req)
    });
  } catch (error) {
    res.json({
      ok: true,
      configured: false,
      message: error.message,
      loginUrl: dingtalkLoginUrl(req)
    });
  }
});

app.get('/api/auth/dingtalk/callback', async (req, res) => {
  try {
    const code = req.query.code || req.query.authCode;
    const authCode = req.query.authCode || req.query.code;
    const { state } = req.query;
    const stateValid = Boolean(code && state && verifyState(req, state));
    const callbackFrontendOrigin = resolveStateFrontendOrigin(state);
    logDingTalkEvent('callback.received', {
      queryKeys: Object.keys(req.query || {}),
      hasCode: Boolean(code),
      codeParam: req.query.code ? 'code' : req.query.authCode ? 'authCode' : '',
      hasState: Boolean(state),
      stateValid,
      host: req.get('host') || '',
      ip: req.ip
    });

    if (!stateValid) {
      logDingTalkEvent('callback.rejected', { reason: 'invalid_state_or_missing_code' });
      sendDingTalkAuthResult(
        res,
        `${callbackFrontendOrigin}/login.html?error=${encodeURIComponent('登录状态已失效，请重新扫码。')}`
      );
      return;
    }

    const user = await fetchDingTalkUser(code, { authCode });
    if (allowedUnionIds.length > 0 && !allowedUnionIds.includes(user.unionid)) {
      logDingTalkEvent('callback.rejected', { reason: 'unionid_not_allowed', hasUnionId: Boolean(user.unionid) });
      sendDingTalkAuthResult(
        res,
        `${callbackFrontendOrigin}/login.html?error=${encodeURIComponent('当前钉钉账号未被授权访问。')}`
      );
      return;
    }

    req.session.dingTalkState = null;
    const role = isAdmin(user) ? 'admin' : 'member';
    const { user: storedUser } = await upsertDingTalkUser(user, role);
    if (storedUser.status === 'disabled') {
      logDingTalkEvent('callback.rejected', { reason: 'user_disabled', userId: storedUser.id });
      sendDingTalkAuthResult(
        res,
        `${callbackFrontendOrigin}/login.html?error=${encodeURIComponent('账号已被禁用，请联系管理员。')}`
      );
      return;
    }

    req.session.user = sessionUserFromDb(storedUser);
    await applySessionPolicy(req);
    logDingTalkEvent('callback.success', {
      userId: storedUser.id,
      role: storedUser.role,
      authType: storedUser.authType,
      redirect: '/login.html?auth_handoff=...'
    });
    sendDingTalkAuthResult(
      res,
      createFrontendUrl('/login.html', { auth_handoff: createLoginHandoffToken(storedUser.id) }, callbackFrontendOrigin)
    );
  } catch (error) {
    logDingTalkEvent('callback.error', { message: error.message });
    sendDingTalkAuthResult(
      res,
      `${resolveStateFrontendOrigin(req.query.state)}/login.html?error=${encodeURIComponent(error.message)}`
    );
  }
});

app.post(
  '/api/auth/dingtalk/verify',
  rateLimit({
    windowMs: 1000 * 60,
    max: 20,
    key: (req) => `dingtalk-verify:${req.ip}`
  }),
  async (req, res, next) => {
    try {
      const authCode = String(req.body?.authCode || '').trim();
      const state = String(req.body?.state || '').trim();
      const stateValid = Boolean(authCode && (!state || verifyState(req, state)));
      logDingTalkEvent('verify.received', {
        hasCode: Boolean(authCode),
        hasState: Boolean(state),
        stateValid,
        ip: req.ip
      });

      if (!authCode) {
        res.status(400).json({ ok: false, message: '缺少授权码，请重新扫码。' });
        return;
      }

      if (!stateValid) {
        logDingTalkEvent('verify.rejected', { reason: 'invalid_state' });
        res.status(400).json({ ok: false, message: '登录状态已失效，请重新扫码。' });
        return;
      }

      const user = await fetchDingTalkUser(authCode, { authCode });
      if (allowedUnionIds.length > 0 && !allowedUnionIds.includes(user.unionid)) {
        logDingTalkEvent('verify.rejected', { reason: 'unionid_not_allowed' });
        res.status(403).json({ ok: false, message: '当前钉钉账号未被授权访问。' });
        return;
      }

      req.session.dingTalkState = null;
      const role = isAdmin(user) ? 'admin' : 'member';
      const { user: storedUser } = await upsertDingTalkUser(user, role);
      if (storedUser.status === 'disabled') {
        logDingTalkEvent('verify.rejected', { reason: 'user_disabled', userId: storedUser.id });
        res.status(403).json({ ok: false, message: '账号已被禁用，请联系管理员。' });
        return;
      }

      req.session.user = sessionUserFromDb(storedUser);
      await applySessionPolicy(req);
      logDingTalkEvent('verify.success', { userId: storedUser.id, role: storedUser.role });
      res.json({ ok: true, user: safeUser(req.session.user) });
    } catch (error) {
      logDingTalkEvent('verify.error', { message: error.message });
      next(error);
    }
  }
);

app.post('/api/auth/password-login',
  rateLimit({
    windowMs: 1000 * 60,
    max: 10,
    key: (req) => `password:${req.ip}:${String(req.body?.username || '').trim().toLowerCase()}`
  }),
  async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const user = await findUserByUsername(username);

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        res.status(401).json({ ok: false, message: '账号或密码错误。' });
        return;
      }

      if (user.status === 'disabled') {
        res.status(403).json({ ok: false, message: '账号已被禁用，请联系管理员。' });
        return;
      }

      const systemSettings = await listSystemSettings();
      if (systemSettings.requireDingTalk === 'true' && user.role !== 'admin') {
        res.status(403).json({ ok: false, message: '当前安全策略要求普通成员使用钉钉扫码登录。' });
        return;
      }

      await touchUserLogin(user.id);
      req.session.user = sessionUserFromDb(user);
      await applySessionPolicy(req, systemSettings);
      res.json({ ok: true, user: safeUser(req.session.user) });
    } catch (error) {
      next(error);
    }
});

app.post(
  '/api/auth/handoff-login',
  rateLimit({
    windowMs: 1000 * 60,
    max: 30,
    key: (req) => `handoff:${req.ip}`
  }),
  async (req, res, next) => {
    try {
      const userId = verifyLoginHandoffToken(req.body?.token);
      if (!userId) {
        logDingTalkEvent('handoff.rejected', {
          reason: 'invalid_token',
          hasToken: Boolean(req.body?.token),
          origin: req.get('origin') || '',
          host: req.get('host') || ''
        });
        res.status(401).json({ ok: false, message: '扫码登录凭证已失效，请重新扫码。' });
        return;
      }

      const user = await findUserById(userId);
      if (!user || user.status === 'disabled') {
        logDingTalkEvent('handoff.rejected', {
          reason: 'user_disabled_or_missing',
          userId,
          origin: req.get('origin') || '',
          host: req.get('host') || ''
        });
        res.status(403).json({ ok: false, message: '账号已被禁用，请联系管理员。' });
        return;
      }

      req.session.user = sessionUserFromDb(user);
      await applySessionPolicy(req);
      logDingTalkEvent('handoff.success', {
        userId: user.id,
        role: user.role,
        authType: user.authType,
        origin: req.get('origin') || '',
        host: req.get('host') || ''
      });
      res.json({ ok: true, user: safeUser(req.session.user) });
    } catch (error) {
      next(error);
    }
});

app.post('/api/auth/change-password', requireLogin, async (req, res, next) => {
  try {
    const user = await changeOwnPassword(req.session.user.id, req.body.currentPassword, req.body.nextPassword);
    if (!user) {
      res.status(404).json({ ok: false, message: '用户不存在。' });
      return;
    }

    req.session.user = sessionUserFromDb(user);
    res.json({ ok: true, user: safeUser(req.session.user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tidesail_sid');
    res.json({ ok: true });
  });
});

app.get('/api/nav/groups', requireLogin, async (req, res, next) => {
  try {
    res.json({ ok: true, groups: await getSiteGroupsForUser(req.session.user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/user/workspace-theme', requireLogin, async (req, res, next) => {
  try {
    res.json({ ok: true, theme: await getUserWorkspaceTheme(req.session.user.id) });
  } catch (error) {
    next(error);
  }
});

app.put('/api/user/workspace-theme', requireLogin, async (req, res, next) => {
  try {
    const theme = await updateUserWorkspaceTheme(req.session.user.id, req.body.theme);
    res.json({ ok: true, theme });
  } catch (error) {
    next(error);
  }
});

app.get('/api/user/home-layout', requireLogin, async (req, res, next) => {
  try {
    res.json({ ok: true, layout: await getUserHomeLayout(req.session.user.id) });
  } catch (error) {
    next(error);
  }
});

app.put('/api/user/home-layout', requireLogin, async (req, res, next) => {
  try {
    const layout = await updateUserHomeLayout(req.session.user.id, req.body.layout);
    res.json({ ok: true, layout });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/user/workspace-theme/background',
  requireLogin,
  rateLimit({
    windowMs: 1000 * 60 * 60,
    max: 20,
    key: (req) => `workspace-background:${req.session.user?.id || req.ip}`
  }),
  async (req, res, next) => {
  try {
    const image = await saveWorkspaceBackground(req.session.user.id, req.body);
    res.status(201).json({ ok: true, image });
  } catch (error) {
    next(error);
  }
});

app.get('/api/user/workspace-theme/backgrounds/:fileName', requireLogin, async (req, res, next) => {
  try {
    const fileName = String(req.params.fileName || '');
    if (!/^[A-Za-z0-9_.-]+$/.test(fileName)) {
      res.status(400).json({ ok: false, message: '背景图片名称无效。' });
      return;
    }

    const filePath = path.join(workspaceBackgroundRoot, String(req.session.user.id), fileName);
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ ok: false, message: '背景图片不存在。' });
      return;
    }
    next(error);
  }
});

app.get('/api/vault/credentials', requireLogin, async (req, res, next) => {
  try {
    res.json({ ok: true, credentials: await listPersonalCredentials(req.session.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/vault/credentials', requireLogin, async (req, res, next) => {
  try {
    const credential = await createPersonalCredential(req.session.user.id, req.body);
    res.status(201).json({ ok: true, credential });
  } catch (error) {
    next(error);
  }
});

app.put('/api/vault/credentials/:id', requireLogin, async (req, res, next) => {
  try {
    const credentialId = parsePositiveId(req.params.id);
    if (!credentialId) {
      res.status(400).json({ ok: false, message: '记录 ID 无效。' });
      return;
    }

    const credential = await updatePersonalCredential(req.session.user.id, credentialId, req.body);
    if (!credential) {
      res.status(404).json({ ok: false, message: '记录不存在。' });
      return;
    }

    res.json({ ok: true, credential });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/vault/credentials/:id', requireLogin, async (req, res, next) => {
  try {
    const credentialId = parsePositiveId(req.params.id);
    if (!credentialId) {
      res.status(400).json({ ok: false, message: '记录 ID 无效。' });
      return;
    }

    const deleted = await deletePersonalCredential(req.session.user.id, credentialId);
    if (!deleted) {
      res.status(404).json({ ok: false, message: '记录不存在。' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get(
  '/api/vault/credentials/:id/secret',
  requireLogin,
  rateLimit({
    windowMs: 1000 * 60,
    max: 60,
    key: (req) => `vault-secret:${req.session.user?.id || req.ip}`
  }),
  async (req, res, next) => {
  try {
    const credentialId = parsePositiveId(req.params.id);
    if (!credentialId) {
      res.status(400).json({ ok: false, message: '记录 ID 无效。' });
      return;
    }

    const secret = await getPersonalCredentialSecret(req.session.user.id, credentialId);
    if (!secret) {
      res.status(404).json({ ok: false, message: '记录不存在。' });
      return;
    }

    res.json({ ok: true, secret });
  } catch (error) {
    next(error);
  }
});

app.get(
  '/api/sso/authorize',
  requireLogin,
  rateLimit({
    windowMs: 1000 * 60,
    max: 120,
    key: (req) => `sso-authorize:${req.session.user?.id || req.ip}`
  }),
  async (req, res, next) => {
  try {
    const target = await resolveAuthorizedSsoTarget(req);
    if (target.status) {
      res.status(target.status).json({ ok: false, message: target.message });
      return;
    }

    await cleanExpiredSsoTickets();
    const ticket = crypto.randomBytes(32).toString('hex');
    const systemSettings = await listSystemSettings();
    const ticketTtlSeconds = Number(systemSettings.ssoTicketTtlSeconds || ssoTicketTtlSeconds) || ssoTicketTtlSeconds;
    const expiresAt = new Date(Date.now() + ticketTtlSeconds * 1000);
    await createSsoTicket({ ticket, targetUrl: target.url, user: req.session.user, expiresAt });

    const url = new URL(target.url);
    url.searchParams.set('sso_ticket', ticket);
    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

app.post('/api/sso/verify', async (req, res, next) => {
  try {
    const ticket = String(req.body.ticket || '').trim();
    if (!ticket) {
      res.status(400).json({ ok: false, message: 'ticket 不能为空。' });
      return;
    }

    const payload = await consumeSsoTicket(ticket);
    if (!payload) {
      res.status(401).json({ ok: false, message: 'ticket 无效或已过期。' });
      return;
    }

    res.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/overview', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, overview: await getAdminOverview() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/settings', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, settings: await listSystemSettings() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/settings', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const settings = await updateSystemSettings(req.body.settings, req.session.user.id);
    await writeAudit(req, 'settings.update', 'system_settings', 'global', '更新系统配置');
    res.json({ ok: true, settings });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/dingtalk/roster-sync', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const settings = await listSystemSettings();
    // 管理中枢没有单独配置同步专用应用时，直接复用登录应用已有的 DingTalk 凭证
    // （.env 里的 DINGTALK_CLIENT_ID/SECRET + DINGTALK_CORP_ID）——同一个应用只要
    // 在钉钉开放平台勾了「通讯录管理只读」权限，就能兼顾登录和花名册同步两件事，
    // 不需要为此专门再建一个应用。
    const appKey = settings.dingtalkRosterAppKey || getDingTalkClientId();
    const corpId = settings.dingtalkRosterCorpId || process.env.DINGTALK_CORP_ID || '';
    const appSecret = (await getDecryptedSystemSetting('dingtalkRosterAppSecret')) || getDingTalkClientSecret();

    const stats = await syncDingTalkRoster({
      appKey,
      appSecret,
      corpId,
      db: { findUserByDingTalkUserId, upsertRosterUser, disableStaleDingTalkUsers }
    });

    await writeAudit(
      req,
      'dingtalk.roster_sync',
      'dingtalk_roster',
      'all',
      `同步钉钉花名册：新建 ${stats.created}，更新 ${stats.updated}，禁用 ${stats.disabled}`
    );
    res.json({ ok: true, stats });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/dingtalk/wiki-sync', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const settings = await listSystemSettings();
    // 同上：默认复用登录应用的凭证，应用需要额外勾「知识库读权限」「知识库节点读权限」。
    const appKey = settings.dingtalkRosterAppKey || getDingTalkClientId();
    const operatorId = settings.dingtalkWikiOperatorId || '';
    const appSecret = (await getDecryptedSystemSetting('dingtalkRosterAppSecret')) || getDingTalkClientSecret();

    const stats = await syncDingTalkWiki({
      appKey,
      appSecret,
      operatorId,
      db: { replaceDingTalkDocs }
    });

    await writeAudit(
      req,
      'dingtalk.wiki_sync',
      'dingtalk_docs',
      'all',
      `同步钉钉知识库：${stats.workspaces} 个知识库，${stats.docs} 篇文档`
    );
    res.json({ ok: true, stats });
  } catch (error) {
    next(error);
  }
});

app.get('/api/knowledge-base', requireLogin, async (req, res, next) => {
  try {
    res.json({ ok: true, docs: await listDingTalkDocs() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/audit-logs', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, logs: await listAuditLogs(req.query.limit) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/backup', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const snapshot = await createAdminBackupSnapshot();
    await writeAudit(req, 'backup.export', 'backup', 'config', '生成后台配置快照');
    res.json({ ok: true, snapshot });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/groups', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, groups: await getSiteGroups({ includePermissions: true }) });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/groups', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const groups = await replaceSiteGroups(req.body.groups);
    await writeAudit(req, 'sites.save', 'nav_groups', 'all', `保存 ${groups.length} 个站点分组`);
    res.json({ ok: true, groups });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/projects', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, projects: await listProjects() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/projects', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const project = await createProject(req.body, req.session.user.id);
    await writeAudit(req, 'project.create', 'project', project.id, `创建项目 ${project.name}`);
    res.status(201).json({ ok: true, project });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/projects/:id', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const projectId = parsePositiveId(req.params.id);
    if (!projectId) {
      res.status(400).json({ ok: false, message: '项目 ID 无效。' });
      return;
    }
    const project = await updateProject(projectId, req.body, req.session.user.id);
    if (!project) {
      res.status(404).json({ ok: false, message: '项目不存在。' });
      return;
    }
    await writeAudit(req, 'project.update', 'project', project.id, `更新项目 ${project.name}`);
    res.json({ ok: true, project });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/projects/:id', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const projectId = parsePositiveId(req.params.id);
    if (!projectId) {
      res.status(400).json({ ok: false, message: '项目 ID 无效。' });
      return;
    }
    const deleted = await deleteProject(projectId);
    if (!deleted) {
      res.status(404).json({ ok: false, message: '项目不存在。' });
      return;
    }
    await writeAudit(req, 'project.delete', 'project', projectId, '删除项目');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, users: await listUsers() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/users', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const user = await createLocalUser(req.body);
    await writeAudit(req, 'user.create', 'user', user.id, `创建用户 ${user.username}`);
    res.status(201).json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/users/:id', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const userId = parsePositiveId(req.params.id);
    if (!userId) {
      res.status(400).json({ ok: false, message: '用户 ID 无效。' });
      return;
    }

    if (userId === req.session.user.id && (req.body.role !== 'admin' || req.body.status === 'disabled')) {
      res.status(400).json({ ok: false, message: '不能降级或禁用当前登录的管理员账号。' });
      return;
    }

    const user = await updateUser(userId, req.body);
    if (!user) {
      res.status(404).json({ ok: false, message: '用户不存在。' });
      return;
    }

    await writeAudit(req, 'user.update', 'user', user.id, `更新用户 ${user.username}`);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/users/:id', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const userId = parsePositiveId(req.params.id);
    if (!userId) {
      res.status(400).json({ ok: false, message: '用户 ID 无效。' });
      return;
    }

    if (userId === req.session.user.id) {
      res.status(400).json({ ok: false, message: '不能删除当前登录的管理员账号。' });
      return;
    }

    const targetUser = await findUserById(userId);
    if (!targetUser) {
      res.status(404).json({ ok: false, message: '用户不存在。' });
      return;
    }

    await deleteUser(userId);
    await writeAudit(req, 'user.delete', 'user', userId, `删除用户 ${targetUser.username}`);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/users/:id/reset-password', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const userId = parsePositiveId(req.params.id);
    if (!userId) {
      res.status(400).json({ ok: false, message: '用户 ID 无效。' });
      return;
    }

    const user = await resetUserPassword(userId, req.body.password);
    if (!user) {
      res.status(404).json({ ok: false, message: '用户不存在。' });
      return;
    }

    await writeAudit(req, 'user.reset_password', 'user', user.id, `重置用户 ${user.username} 的临时密码`);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/auth/dingtalk/client-log',
  rateLimit({
    windowMs: 1000 * 60,
    max: 240,
    key: (req) => `dingtalk-client-log:${req.ip}`
  }),
  (req, res) => {
    logDingTalkEvent('client.event', {
      event: String(req.body?.event || '').slice(0, 80),
      href: String(req.body?.href || '').slice(0, 220),
      path: String(req.body?.path || '').slice(0, 120),
      detail: req.body?.detail ?? '',
      meta: req.body?.meta || {},
      userAgent: String(req.get('user-agent') || '').slice(0, 180)
    });
    res.json({ ok: true });
  }
);

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({ ok: false, message: error.message || '服务异常。' });
});

function logDingTalkEvent(event, detail = {}) {
  const safeDetail = sanitizeDingTalkLogValue(detail);
  console.info(`[dingtalk] ${event} ${JSON.stringify(safeDetail)}`);
  appendDingTalkEventLog(event, safeDetail);
}

function appendDingTalkEventLog(event, detail) {
  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    event,
    detail
  })}\n`;
  fs.mkdir(path.dirname(dingTalkEventLogPath), { recursive: true })
    .then(() => fs.appendFile(dingTalkEventLogPath, line, 'utf8'))
    .catch((error) => {
      console.error('Failed to append DingTalk event log:', error.message);
    });
}

function sanitizeDingTalkLogValue(value, key = '', depth = 0) {
  const normalizedKey = String(key || '').toLowerCase();
  const shouldRedact =
    normalizedKey !== 'errorcode' &&
    !normalizedKey.startsWith('has') &&
    (normalizedKey === 'code' ||
      normalizedKey === 'authcode' ||
      normalizedKey === 'token' ||
      normalizedKey.endsWith('token') ||
      normalizedKey.includes('secret') ||
      normalizedKey.includes('password'));

  if (shouldRedact) {
    return value ? '[redacted]' : value;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactDingTalkLogText(value).slice(0, 900);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= 5) {
    return '[depth-limit]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeDingTalkLogValue(item, key, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([entryKey, entryValue]) => [entryKey, sanitizeDingTalkLogValue(entryValue, entryKey, depth + 1)])
    );
  }

  return String(value).slice(0, 300);
}

function redactDingTalkLogText(text) {
  return String(text || '')
    .replace(/([?&](?:code|authCode|access_token|token|client_secret|password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/("?(?:code|authCode|accessToken|access_token|token|clientSecret|client_secret|password)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[redacted]$3');
}

function parseList(value = '') {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readUrlParam(value, key) {
  try {
    return new URL(value).searchParams.get(key) || '';
  } catch {
    return '';
  }
}

function rateLimit({ windowMs, max, key, message = '请求过于频繁，请稍后再试。' }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = String(key(req));
    const existingBucket = rateLimitBuckets.get(bucketKey);
    const bucket =
      existingBucket && existingBucket.resetAt > now
        ? existingBucket
        : {
            count: 0,
            resetAt: now + windowMs
          };

    bucket.count += 1;
    rateLimitBuckets.set(bucketKey, bucket);

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ ok: false, message });
      return;
    }

    next();
  };
}

function pruneRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}

function isAdmin(user) {
  if (!user) {
    return false;
  }
  if (user.role === 'admin') {
    return true;
  }
  if (adminUnionIds.includes(user.unionid)) {
    return true;
  }
  return adminNicks.includes(String(user.nick || '').trim().toLowerCase());
}

function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    nick: user.nick,
    unionid: user.unionid,
    openid: user.openid,
    dingtalkUserId: user.dingtalkUserId || user.dingtalk_userid || '',
    dingtalkCorpId: user.dingtalkCorpId || user.dingtalk_corp_id || '',
    username: user.username,
    role: user.role || (isAdmin(user) ? 'admin' : 'member'),
    status: user.status || 'active',
    mustChangePassword: Boolean(user.mustChangePassword ?? user.must_change_password)
  };
}

function requireLogin(req, res, next) {
  Promise.resolve()
    .then(async () => {
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
      if (currentUser.mustChangePassword && req.path !== '/api/auth/change-password') {
        res.status(403).json({
          ok: false,
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: '首次登录必须修改密码。'
        });
        return;
      }

      next();
    })
    .catch(next);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.session.user)) {
    next();
    return;
  }

  res.status(403).json({ ok: false, message: '没有后台权限。' });
}

async function writeAudit(req, action, targetType, targetId, summary) {
  try {
    await recordAuditLog({
      actor: req.session.user,
      action,
      targetType,
      targetId,
      summary,
      ip: req.ip,
      userAgent: req.get('user-agent') || ''
    });
  } catch (error) {
    console.error('Failed to record admin audit log:', error.message);
  }
}

async function applySessionPolicy(req, existingSettings = null) {
  const systemSettings = existingSettings || (await listSystemSettings());
  const sessionHours = Math.min(Math.max(Number(systemSettings.sessionHours || 8) || 8, 1), 168);
  req.session.cookie.maxAge = 1000 * 60 * 60 * sessionHours;
}

function assertDingTalkConfig() {
  if (!getDingTalkClientId() || !getDingTalkClientSecret()) {
    throw new Error('请在 .env 配置 DINGTALK_CLIENT_ID/DINGTALK_CLIENT_SECRET，或兼容使用 DINGTALK_APP_ID/DINGTALK_APP_SECRET。');
  }
}

function resolveFrontendOrigin(req) {
  const origin = req.get('origin');
  if (isAllowedFrontendOrigin(origin)) {
    return origin;
  }

  const referer = req.get('referer');
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (isAllowedFrontendOrigin(refererOrigin)) {
        return refererOrigin;
      }
    } catch {}
  }

  return frontendOrigin;
}

function normalizeFrontendOrigin(origin) {
  return isAllowedFrontendOrigin(String(origin || '')) ? String(origin) : frontendOrigin;
}

function isAllowedFrontendOrigin(origin) {
  if (!origin) {
    return false;
  }

  if (frontendOrigins.includes(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.port === '2223' && isLocalDevHost(url.hostname);
  } catch {
    return false;
  }
}

function isLocalDevHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '::1') {
    return true;
  }

  // Must be a syntactically complete IPv4 address before checking private
  // ranges — a plain startsWith('192.168.') would also match a hostile
  // domain like "192.168.0.1.attacker.com", which is not a private IP at
  // all. Requiring the full dotted-quad closes that spoofing path.
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 127 || (a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31);
}

function createState(req, frontendOriginOverride = '') {
  const payload = Buffer.from(
    JSON.stringify({
      nonce: crypto.randomBytes(18).toString('hex'),
      timestamp: Date.now(),
      frontendOrigin: frontendOriginOverride ? normalizeFrontendOrigin(frontendOriginOverride) : resolveFrontendOrigin(req)
    })
  ).toString('base64url');
  const signature = signState(payload);
  const state = `${payload}.${signature}`;
  req.session.dingTalkState = state;
  return state;
}

function createDingTalkAuthUrl(req, options = {}) {
  const state = options.state || createState(req, options.frontendOrigin);
  const loginUrl = new URL('https://login.dingtalk.com/oauth2/auth');
  const mode = options.mode || 'page';
  const scope = getDingTalkOAuthScope();
  loginUrl.searchParams.set('client_id', getDingTalkClientId());
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('scope', scope);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('redirect_uri', redirectUri);
  if (mode === 'iframe') {
    loginUrl.searchParams.set('iframe', 'true');
    loginUrl.searchParams.set('FEShowIframeTips', 'true');
  }
  const prompt =
    process.env.DINGTALK_OAUTH_PROMPT || (dingTalkScopeIncludes(scope, dingTalkProfileScope) ? 'consent' : '');
  if (prompt) {
    loginUrl.searchParams.set('prompt', prompt);
  }
  if (process.env.DINGTALK_CORP_ID && dingTalkScopeIncludes(scope, 'corpid')) {
    loginUrl.searchParams.set('corpId', process.env.DINGTALK_CORP_ID);
    if (process.env.DINGTALK_ORG_TYPE) {
      loginUrl.searchParams.set('org_type', process.env.DINGTALK_ORG_TYPE);
    }
  }
  return loginUrl.toString();
}

function getDingTalkOAuthScope() {
  const configured = process.env.DINGTALK_OAUTH_SCOPE || `openid corpid ${dingTalkProfileScope}`;
  const scopes = [];
  const scopeKeys = new Set();
  const addScope = (scope) => {
    const value = String(scope || '').trim();
    const key = value.toLowerCase();
    if (!value || scopeKeys.has(key)) {
      return;
    }
    scopeKeys.add(key);
    scopes.push(value);
  };

  configured.trim().split(/\s+/).forEach(addScope);
  addScope('openid');
  if (process.env.DINGTALK_CORP_ID) {
    addScope('corpid');
  }
  if (process.env.DINGTALK_REQUIRE_PROFILE_SCOPE !== 'false') {
    addScope(dingTalkProfileScope);
  }
  return scopes.join(' ');
}

function dingTalkScopeIncludes(scope, target) {
  return String(scope || '')
    .split(/\s+/)
    .some((item) => item.toLowerCase() === String(target || '').toLowerCase());
}

function sendDingTalkAuthResult(res, targetUrl) {
  const safeTarget = JSON.stringify(targetUrl);
  allowDingTalkFrameEmbedding(res, new URL(targetUrl).origin);
  res.type('html').send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>钉钉登录中...</title>
    <style>
      body {
        margin: 0;
        display: grid;
        min-height: 100vh;
        place-items: center;
        background: #0b0f14;
        color: #dbe7ef;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      a { color: #6ee7b7; }
    </style>
  </head>
  <body>
    <main>
      <p>钉钉授权已返回，正在进入汐航...</p>
      <p><a id="fallbackLink" href="#">如果没有自动跳转，请点这里继续</a></p>
    </main>
    <script>
      const target = ${safeTarget};
      document.getElementById('fallbackLink').href = target;
      const targetOrigin = new URL(target).origin;
      const payload = { type: 'xihang:dingtalk-auth', target };
      try {
        const logPayload = JSON.stringify({
          event: 'callback-page.loaded',
          detail: target.includes('auth_handoff=') ? 'has_handoff' : 'no_handoff',
          href: window.location.href,
          path: window.location.pathname
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/auth/dingtalk/client-log', new Blob([logPayload], { type: 'application/json' }));
        } else {
          fetch('/api/auth/dingtalk/client-log', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: logPayload,
            keepalive: true
          }).catch(() => {});
        }
      } catch (error) {}
      const notifyLoginPage = (origin) => {
        try { window.parent.postMessage(payload, origin); } catch (error) {}
        try { window.top.postMessage(payload, origin); } catch (error) {}
      };
      try {
        notifyLoginPage(targetOrigin);
        window.setTimeout(() => notifyLoginPage('*'), 200);
        window.setTimeout(() => window.top.location.replace(target), 500);
      } catch (error) {
        window.setTimeout(() => window.location.replace(target), 500);
      }
    </script>
  </body>
</html>`);
}

function allowDingTalkFrameEmbedding(res, frontendOriginForFrame) {
  res.removeHeader('X-Frame-Options');
  const frameAncestors = isAllowedFrontendOrigin(frontendOriginForFrame) ? `'self' ${frontendOriginForFrame}` : "'self'";
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors ${frameAncestors}; frame-src https://login.dingtalk.com https://*.dingtalk.com https://*.alicdn.com https://*.aliyun.com;`
  );
}

function createFrontendUrl(pathname, params = {}, origin = frontendOrigin) {
  const baseOrigin = isAllowedFrontendOrigin(origin) ? origin : frontendOrigin;
  const url = new URL(pathname, baseOrigin.endsWith('/') ? baseOrigin : `${baseOrigin}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function verifyState(req, state) {
  const stateText = String(state || '');
  if (req.session.dingTalkState && req.session.dingTalkState === stateText) {
    return true;
  }

  return Boolean(readDingTalkStatePayload(stateText));
}

function resolveStateFrontendOrigin(state) {
  const payload = readDingTalkStatePayload(state);
  return isAllowedFrontendOrigin(payload?.frontendOrigin) ? payload.frontendOrigin : frontendOrigin;
}

function readDingTalkStatePayload(state) {
  const stateText = String(state || '');
  const dotIdx = stateText.lastIndexOf('.');
  if (dotIdx <= 0) {
    console.info('[dingtalk-debug] state has no dot, len=' + stateText.length);
    return null;
  }
  const payload = stateText.slice(0, dotIdx);
  const signature = stateText.slice(dotIdx + 1);
  const expected = signState(payload);
  const match = safeEqual(signature, expected);
  if (!match) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const age = Date.now() - Number(data.timestamp || 0);
    if (age >= 1000 * 60 * 10) {
      console.info('[dingtalk-debug] state expired, age=' + age + 'ms');
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function signState(payload) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-change-me')
    .update(payload)
    .digest('base64url');
}

function createLoginHandoffToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      nonce: crypto.randomBytes(18).toString('hex'),
      expiresAt: Date.now() + 1000 * 60 * 2
    })
  ).toString('base64url');
  return `${payload}.${signLoginHandoff(payload)}`;
}

// Tracks handoff nonces already redeemed so a captured token can't be
// replayed for the rest of its 2-minute window — mirrors the one-time
// consumption the SSO ticket flow already does in the database, just kept
// in memory here since the window is short and the value never needs to
// survive a restart.
const consumedHandoffNonces = new Map();

function verifyLoginHandoffToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(signature, signLoginHandoff(payload))) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const userId = Number(data.userId);
    const expiresAt = Number(data.expiresAt || 0);
    if (!Number.isSafeInteger(userId) || userId <= 0 || expiresAt < Date.now()) {
      return null;
    }
    if (!data.nonce || consumedHandoffNonces.has(data.nonce)) {
      return null;
    }

    consumedHandoffNonces.set(data.nonce, expiresAt);
    if (consumedHandoffNonces.size > 500) {
      const now = Date.now();
      for (const [nonce, storedExpiresAt] of consumedHandoffNonces) {
        if (storedExpiresAt < now) consumedHandoffNonces.delete(nonce);
      }
    }

    return userId;
  } catch {
    return null;
  }
}

function signLoginHandoff(payload) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-change-me')
    .update(`login-handoff:${payload}`)
    .digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getDingTalkClientId() {
  return process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_APP_ID || '';
}

function getDingTalkClientSecret() {
  return process.env.DINGTALK_CLIENT_SECRET || process.env.DINGTALK_APP_SECRET || '';
}

async function fetchDingTalkUser(code, options = {}) {
  assertDingTalkConfig();

  const tokenResponse = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: getDingTalkClientId(),
      clientSecret: getDingTalkClientSecret(),
      code: String(code),
      grantType: 'authorization_code'
    })
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  logDingTalkEvent('token.response', {
    status: tokenResponse.status,
    ok: tokenResponse.ok,
    hasAccessToken: Boolean(tokenPayload.accessToken),
    hasUnionId: Boolean(tokenPayload.unionId || tokenPayload.unionid),
    hasOpenId: Boolean(tokenPayload.openId || tokenPayload.openid),
    hasCorpId: Boolean(tokenPayload.corpId),
    payloadKeys: getSafePayloadKeys(tokenPayload),
    errorCode: tokenPayload.code || tokenPayload.errcode || ''
  });

  if (!tokenResponse.ok || !tokenPayload.accessToken) {
    throw createDingTalkError('钉钉授权码换取访问令牌失败', tokenResponse, tokenPayload);
  }

  const profileResponse = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    method: 'GET',
    headers: {
      'x-acs-dingtalk-access-token': tokenPayload.accessToken
    }
  });
  const profilePayload = await profileResponse.json().catch(() => ({}));
  logDingTalkEvent('profile.response', {
    status: profileResponse.status,
    ok: profileResponse.ok,
    hasUnionId: Boolean(profilePayload.unionId || profilePayload.unionid),
    hasOpenId: Boolean(profilePayload.openId || profilePayload.openid),
    requiredScopes: getDingTalkRequiredScopes(profilePayload),
    payloadKeys: getSafePayloadKeys(profilePayload),
    errorCode: profilePayload.code || profilePayload.errcode || ''
  });

  if (profileResponse.ok && hasDingTalkIdentity(profilePayload)) {
    return enrichDingTalkUserWithEmployee(normalizeDingTalkUser(profilePayload, tokenPayload));
  }

  if (hasDingTalkIdentity(tokenPayload)) {
    logDingTalkEvent('profile.fallback', {
      reason: profileResponse.ok ? 'profile_missing_identity' : 'profile_read_failed',
      profileStatus: profileResponse.status,
      profileErrorCode: profilePayload.code || profilePayload.errcode || '',
      requiredScopes: getDingTalkRequiredScopes(profilePayload),
      identitySource: tokenPayload.unionId || tokenPayload.unionid ? 'token.unionId' : 'token.openId'
    });
    return enrichDingTalkUserWithEmployee(normalizeDingTalkUser({}, tokenPayload));
  }

  const legacyPayload = await fetchDingTalkLegacySnsUserByCode(options.authCode || code, tokenPayload);
  if (hasDingTalkIdentity(legacyPayload)) {
    logDingTalkEvent('profile.legacy-fallback', {
      hasUnionId: Boolean(legacyPayload.unionid || legacyPayload.unionId),
      hasOpenId: Boolean(legacyPayload.openid || legacyPayload.openId),
      hasNick: Boolean(legacyPayload.nick)
    });
    return enrichDingTalkUserWithEmployee(normalizeDingTalkUser(legacyPayload, tokenPayload));
  }

  const employeePayload = await fetchDingTalkEmployeeByAuthCode(options.authCode || code, tokenPayload);
  if (employeePayload?.fallbackError) {
    throw new Error(employeePayload.fallbackError);
  }
  if (employeePayload?.userid || employeePayload?.userId) {
    logDingTalkEvent('profile.employee-fallback', {
      userId: employeePayload.userid || employeePayload.userId,
      hasName: Boolean(employeePayload.name),
      source: employeePayload.source || 'topapi'
    });
    return normalizeDingTalkUser(employeePayload, tokenPayload);
  }

  const requiredScopes = getDingTalkRequiredScopes(profilePayload);
  const prefix = isDingTalkProfilePermissionDenied(profilePayload)
    ? `钉钉用户信息读取失败：登录链接已包含 ${dingTalkProfileScope} 和 prompt=consent，但本次 OAuth 授权令牌仍没有拿到 ${requiredScopes || dingTalkProfileScope}。请在手机授权页同意该权限，并确认钉钉开放平台接口权限范围包含该员工`
    : '钉钉用户信息读取失败';
  throw createDingTalkError(prefix, profileResponse, profilePayload);
}

async function fetchDingTalkLegacySnsUserByCode(authCode, tokenPayload = {}) {
  const code = String(authCode || '').trim();
  if (!code) {
    return {};
  }

  try {
    const timestamp = Date.now();
    const signature = encodeURIComponent(
      crypto.createHmac('sha256', getDingTalkClientSecret()).update(String(timestamp)).digest('base64')
    );
    const url = `https://oapi.dingtalk.com/sns/getuserinfo_bycode?accessKey=${encodeURIComponent(
      getDingTalkClientId()
    )}&timestamp=${timestamp}&signature=${signature}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tmp_auth_code: code })
    });
    const payload = await response.json().catch(() => ({}));
    const userInfo = payload.user_info || payload.userInfo || {};
    logDingTalkEvent('legacy-sns.response', {
      status: response.status,
      ok: response.ok && Number(payload.errcode || 0) === 0,
      errcode: payload.errcode ?? '',
      hasUnionId: Boolean(userInfo.unionid || userInfo.unionId),
      hasOpenId: Boolean(userInfo.openid || userInfo.openId),
      payloadKeys: getSafePayloadKeys(payload),
      userKeys: getSafePayloadKeys(userInfo)
    });

    if (!response.ok || Number(payload.errcode || 0) !== 0 || !hasDingTalkIdentity(userInfo)) {
      return {};
    }

    return {
      nick: userInfo.nick || userInfo.name || '',
      unionid: userInfo.unionid || userInfo.unionId || '',
      openid: userInfo.openid || userInfo.openId || '',
      corpId: tokenPayload.corpId || process.env.DINGTALK_CORP_ID || '',
      source: 'legacy-sns'
    };
  } catch (error) {
    logDingTalkEvent('legacy-sns.error', { message: error.message });
    return {};
  }
}

async function fetchDingTalkEmployeeByAuthCode(authCode, tokenPayload = {}) {
  const code = String(authCode || '').trim();
  if (!code) {
    return null;
  }

  try {
    const accessToken = await getDingTalkAppAccessToken();
    const userInfoResponse = await fetch(
      `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      }
    );
    const userInfoPayload = await userInfoResponse.json().catch(() => ({}));
    const result = userInfoPayload.result || {};
    logDingTalkEvent('employee-code.response', {
      status: userInfoResponse.status,
      ok: userInfoResponse.ok && Number(userInfoPayload.errcode || 0) === 0,
      errcode: userInfoPayload.errcode ?? '',
      hasUserId: Boolean(result.userid || result.userId),
      payloadKeys: getSafePayloadKeys(userInfoPayload),
      resultKeys: getSafePayloadKeys(result)
    });

    if (!userInfoResponse.ok || Number(userInfoPayload.errcode || 0) !== 0 || !(result.userid || result.userId)) {
      const fallbackError = createDingTalkEmployeeFallbackError(userInfoPayload);
      if (fallbackError) {
        return { fallbackError };
      }
      return null;
    }

    const userId = result.userid || result.userId;
    const employee = await fetchDingTalkEmployeeDetail(accessToken, userId);
    return {
      ...employee,
      ...result,
      userid: userId,
      corpId: tokenPayload.corpId || process.env.DINGTALK_CORP_ID || '',
      source: employee?.name ? 'topapi.detail' : 'topapi.authcode'
    };
  } catch (error) {
    logDingTalkEvent('employee-code.error', { message: error.message });
    return { fallbackError: error.message };
  }
}

function createDingTalkEmployeeFallbackError(payload = {}) {
  const code = payload.errcode ?? payload.code ?? '';
  const message = payload.errmsg || payload.message || '';
  if (Number(code) === 88 || String(message).includes('白名单') || String(message).includes('60020')) {
    return `钉钉企业内部应用接口被 IP 白名单拦截，无法用授权码换员工 userid。请在钉钉开放平台把当前服务器出口 IP 加入应用 IP 白名单，或关闭该应用的 IP 白名单限制：${message || code}`;
  }

  return '';
}

async function getDingTalkAppAccessToken() {
  if (dingTalkAppAccessTokenCache?.token && dingTalkAppAccessTokenCache.expiresAt > Date.now() + 1000 * 60) {
    return dingTalkAppAccessTokenCache.token;
  }

  const tokenUrl = new URL('https://oapi.dingtalk.com/gettoken');
  tokenUrl.searchParams.set('appkey', getDingTalkClientId());
  tokenUrl.searchParams.set('appsecret', getDingTalkClientSecret());
  const response = await fetch(tokenUrl);
  const payload = await response.json().catch(() => ({}));
  logDingTalkEvent('app-token.response', {
    status: response.status,
    ok: response.ok && Number(payload.errcode || 0) === 0,
    errcode: payload.errcode ?? '',
    hasAccessToken: Boolean(payload.access_token)
  });

  if (!response.ok || Number(payload.errcode || 0) !== 0 || !payload.access_token) {
    throw createDingTalkError('钉钉企业应用访问令牌获取失败', response, payload);
  }

  dingTalkAppAccessTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(Number(payload.expires_in || 7200) - 120, 60) * 1000
  };
  return dingTalkAppAccessTokenCache.token;
}

async function fetchDingTalkEmployeeDetail(accessToken, userId) {
  const response = await fetch(
    `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userid: userId })
    }
  );
  const payload = await response.json().catch(() => ({}));
  const result = payload.result || {};
  logDingTalkEvent('employee-detail.response', {
    status: response.status,
    ok: response.ok && Number(payload.errcode || 0) === 0,
    errcode: payload.errcode ?? '',
    hasName: Boolean(result.name),
    hasUnionId: Boolean(result.unionid || result.unionId),
    resultKeys: getSafePayloadKeys(result)
  });

  if (!response.ok || Number(payload.errcode || 0) !== 0) {
    return {};
  }

  return {
    userid: result.userid || userId,
    name: result.name || '',
    unionid: result.unionid || result.unionId || '',
    mobile: result.mobile || '',
    email: result.email || '',
    avatarUrl: result.avatar || result.avatarUrl || ''
  };
}

async function fetchDingTalkEmployeeByUnionId(unionId) {
  const unionid = String(unionId || '').trim();
  if (!unionid) {
    return {};
  }

  try {
    const accessToken = await getDingTalkAppAccessToken();
    const response = await fetch(
      `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unionid })
      }
    );
    const payload = await response.json().catch(() => ({}));
    const result = payload.result || {};
    const userId = result.userid || result.userId || '';
    logDingTalkEvent('employee-unionid.response', {
      status: response.status,
      ok: response.ok && Number(payload.errcode || 0) === 0,
      errcode: payload.errcode ?? '',
      hasUserId: Boolean(userId),
      payloadKeys: getSafePayloadKeys(payload),
      resultKeys: getSafePayloadKeys(result)
    });

    if (!response.ok || Number(payload.errcode || 0) !== 0 || !userId) {
      return {};
    }

    const employee = await fetchDingTalkEmployeeDetail(accessToken, userId);
    return {
      ...employee,
      userid: userId
    };
  } catch (error) {
    logDingTalkEvent('employee-unionid.error', { message: error.message });
    return {};
  }
}

async function enrichDingTalkUserWithEmployee(user) {
  if (user.userid || !user.unionid || !process.env.DINGTALK_CORP_ID) {
    return user;
  }

  const employee = await fetchDingTalkEmployeeByUnionId(user.unionid);
  if (!employee.userid) {
    return user;
  }

  return {
    ...user,
    userid: employee.userid,
    nick: employee.name || user.nick,
    mobile: user.mobile || employee.mobile || '',
    email: user.email || employee.email || '',
    avatarUrl: user.avatarUrl || employee.avatarUrl || ''
  };
}

function normalizeDingTalkUser(profile, token) {
  const unionid = profile.unionId || profile.unionid || token.unionId || token.unionid || '';
  const openid = profile.openId || profile.openid || token.openId || token.openid || '';
  const userid = profile.userid || profile.userId || profile.dingtalkUserId || '';
  const corpId = profile.corpId || profile.corp_id || token.corpId || process.env.DINGTALK_CORP_ID || '';
  const nick = profile.nick || profile.name || profile.mobile || profile.email || userid || openid || unionid || '钉钉用户';

  return {
    nick,
    unionid,
    openid,
    userid,
    avatarUrl: profile.avatarUrl || '',
    email: profile.email || '',
    mobile: profile.mobile || '',
    corpId
  };
}

function hasDingTalkIdentity(payload = {}) {
  return Boolean(payload.unionId || payload.unionid || payload.openId || payload.openid);
}

function isDingTalkProfilePermissionDenied(payload = {}) {
  return String(payload.code || payload.errcode || '').includes('AccessTokenPermissionDenied');
}

function getDingTalkRequiredScopes(payload = {}) {
  const scopes =
    payload.accessdenieddetail?.requiredScopes ||
    payload.accessDeniedDetail?.requiredScopes ||
    payload.access_denied_detail?.requiredScopes ||
    payload.requiredScopes ||
    [];
  return Array.isArray(scopes) ? scopes.join(',') : String(scopes || '');
}

function getSafePayloadKeys(payload = {}) {
  const hiddenKeys = new Set(['accessToken', 'access_token', 'refreshToken', 'refresh_token', 'token', 'clientSecret', 'client_secret']);
  return Object.keys(payload)
    .filter((key) => !hiddenKeys.has(key))
    .sort()
    .join(',');
}

function createDingTalkError(prefix, response, payload) {
  const code = payload.code || payload.errcode || response.status;
  const message = payload.message || payload.errmsg || payload.error_description || payload.error || '未知错误';
  return new Error(`${prefix}：${message}（${code}）`);
}

function dingtalkLoginUrl(req) {
  return `${req.protocol}://${req.get('host')}/api/auth/dingtalk`;
}

async function resolveAuthorizedSsoTarget(req) {
  const siteId = parsePositiveId(req.query.siteId);
  const redirect = String(req.query.redirect || '').trim();

  if (!siteId && !redirect) {
    return { status: 400, message: '请提供有效的站点入口。' };
  }

  if (redirect && !isHttpUrl(redirect)) {
    return { status: 400, message: 'redirect 必须是合法的 http/https 地址。' };
  }

  const groups = await getSiteGroupsForUser(req.session.user);
  const sites = groups.flatMap((group) => group.sites || []);
  const site = siteId
    ? sites.find((item) => Number(item.id) === siteId)
    : sites.find((item) => sameHttpUrl(item.url, redirect));

  if (!site || !isHttpUrl(site.url)) {
    return { status: 403, message: '没有这个站点的 SSO 访问权限。' };
  }

  return {
    url: site.url,
    site
  };
}

function sameHttpUrl(left, right) {
  const normalizedLeft = normalizeComparableHttpUrl(left);
  const normalizedRight = normalizeComparableHttpUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizeComparableHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function saveWorkspaceBackground(userId, value) {
  const image = normalizeWorkspaceBackgroundUpload(value);
  const extension = extensionByMime(image.mimeType);
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
  const userDir = path.join(workspaceBackgroundRoot, String(userId));
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, fileName), image.buffer);

  return {
    fileName,
    imageUrl: `/uploads/workspace-backgrounds/${userId}/${fileName}`,
    size: image.buffer.length,
    mimeType: image.mimeType
  };
}

function normalizeWorkspaceBackgroundUpload(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('上传参数无效。');
  }

  const mimeType = String(value.mimeType || '').trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
    throw new Error('只支持 JPG、PNG、WebP 或 GIF 背景图。');
  }

  const rawData = String(value.data || value.dataUrl || '');
  const base64 = rawData.includes(',') ? rawData.split(',').pop() : rawData;
  if (!base64 || !/^[A-Za-z0-9+/=_-]+$/.test(base64)) {
    throw new Error('背景图片数据无效。');
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw new Error('背景图片不能为空。');
  }

  if (buffer.length > 5 * 1024 * 1024) {
    throw new Error('背景图片不能超过 5MB。');
  }

  assertImageSignature(buffer, mimeType);
  return { buffer, mimeType };
}

function extensionByMime(mimeType) {
  return {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  }[mimeType];
}

function assertImageSignature(buffer, mimeType) {
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  const header = buffer.subarray(0, 12).toString('ascii');
  const isWebp = header.startsWith('RIFF') && header.endsWith('WEBP');
  const isGif = header.startsWith('GIF87a') || header.startsWith('GIF89a');

  if (
    (mimeType === 'image/jpeg' && isJpeg) ||
    (mimeType === 'image/png' && isPng) ||
    (mimeType === 'image/webp' && isWebp) ||
    (mimeType === 'image/gif' && isGif)
  ) {
    return;
  }

  throw new Error('背景图片内容和文件类型不一致。');
}

function sessionUserFromDb(user) {
  return {
    id: user.id,
    username: user.username,
    nick: user.nick || user.username,
    unionid: user.unionid,
    openid: user.openid,
    dingtalkUserId: user.dingtalkUserId || user.dingtalk_userid || '',
    dingtalkCorpId: user.dingtalkCorpId || user.dingtalk_corp_id || '',
    role: user.role || 'member',
    status: user.status || 'active',
    mustChangePassword: Boolean(user.mustChangePassword ?? user.must_change_password)
  };
}

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`汐航 API is running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error.message);
    process.exit(1);
  });
