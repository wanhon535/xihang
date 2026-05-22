import crypto from 'node:crypto';
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
  createSsoTicket,
  deletePersonalCredential,
  deleteUser,
  findUserById,
  findUserByUsername,
  getAdminOverview,
  getPersonalCredentialSecret,
  getSiteGroups,
  initDatabase,
  listAuditLogs,
  listPersonalCredentials,
  listSystemSettings,
  listUsers,
  replaceSiteGroups,
  recordAuditLog,
  resetUserPassword,
  touchUserLogin,
  updatePersonalCredential,
  updateSystemSettings,
  updateUser,
  upsertDingTalkUser
} from './db.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 2222);
const frontendOrigins = parseList(process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:2223,http://localhost:2223');
const frontendOrigin = frontendOrigins[0];
const redirectUri = process.env.DINGTALK_REDIRECT_URI || `http://127.0.0.1:${port}/api/auth/dingtalk/callback`;
const allowedUnionIds = parseList(process.env.ALLOWED_DINGTALK_UNION_IDS);
const adminUnionIds = parseList(process.env.ADMIN_DINGTALK_UNION_IDS);
const adminNicks = parseList(process.env.ADMIN_DINGTALK_NICKS || 'admin').map((item) => item.toLowerCase());
const ssoTicketTtlSeconds = Number(process.env.SSO_TICKET_TTL_SECONDS || 120);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    name: 'tidesail_sid',
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
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
    const state = createState(req);
    const loginUrl = new URL('https://oapi.dingtalk.com/connect/qrconnect');
    loginUrl.searchParams.set('appid', process.env.DINGTALK_APP_ID);
    loginUrl.searchParams.set('response_type', 'code');
    loginUrl.searchParams.set('scope', 'snsapi_login');
    loginUrl.searchParams.set('state', state);
    loginUrl.searchParams.set('redirect_uri', redirectUri);
    res.redirect(loginUrl.toString());
  } catch (error) {
    res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent(error.message)}`);
  }
});

app.get('/api/auth/dingtalk/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.dingTalkState) {
      res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent('登录状态已失效，请重新扫码。')}`);
      return;
    }

    const user = await fetchDingTalkUser(code);
    if (allowedUnionIds.length > 0 && !allowedUnionIds.includes(user.unionid)) {
      res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent('当前钉钉账号未被授权访问。')}`);
      return;
    }

    req.session.dingTalkState = null;
    const role = isAdmin(user) ? 'admin' : 'member';
    const { user: storedUser } = await upsertDingTalkUser(user, role);
    if (storedUser.status === 'disabled') {
      res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent('账号已被禁用，请联系管理员。')}`);
      return;
    }

    req.session.user = sessionUserFromDb(storedUser);
    await applySessionPolicy(req);
    res.redirect(
      Boolean(storedUser.mustChangePassword ?? storedUser.must_change_password)
        ? `${frontendOrigin}/change-password.html`
        : frontendOrigin
    );
  } catch (error) {
    res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/auth/password-login', async (req, res, next) => {
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
    res.json({ ok: true, groups: await getSiteGroups() });
  } catch (error) {
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

app.get('/api/vault/credentials/:id/secret', requireLogin, async (req, res, next) => {
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

app.get('/api/sso/authorize', requireLogin, async (req, res, next) => {
  try {
    const targetUrl = String(req.query.redirect || '').trim();
    if (!isHttpUrl(targetUrl)) {
      res.status(400).json({ ok: false, message: 'redirect 必须是合法的 http/https 地址。' });
      return;
    }

    await cleanExpiredSsoTickets();
    const ticket = crypto.randomBytes(32).toString('hex');
    const systemSettings = await listSystemSettings();
    const ticketTtlSeconds = Number(systemSettings.ssoTicketTtlSeconds || ssoTicketTtlSeconds) || ssoTicketTtlSeconds;
    const expiresAt = new Date(Date.now() + ticketTtlSeconds * 1000);
    await createSsoTicket({ ticket, targetUrl, user: req.session.user, expiresAt });

    const url = new URL(targetUrl);
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
    res.json({ ok: true, groups: await getSiteGroups() });
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

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({ ok: false, message: error.message || '服务异常。' });
});

function parseList(value = '') {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
  if (!process.env.DINGTALK_APP_ID || !process.env.DINGTALK_APP_SECRET) {
    throw new Error('DINGTALK_APP_ID and DINGTALK_APP_SECRET are required. Copy .env.example to .env and fill them in.');
  }
}

function createState(req) {
  const state = crypto.randomBytes(18).toString('hex');
  req.session.dingTalkState = state;
  return state;
}

function signDingTalk(timestamp, appSecret) {
  const signature = crypto.createHmac('sha256', appSecret).update(String(timestamp)).digest('base64');
  return encodeURIComponent(signature);
}

async function fetchDingTalkUser(code) {
  assertDingTalkConfig();

  const timestamp = Date.now();
  const signature = signDingTalk(timestamp, process.env.DINGTALK_APP_SECRET);
  const url = `https://oapi.dingtalk.com/sns/getuserinfo_bycode?accessKey=${encodeURIComponent(
    process.env.DINGTALK_APP_ID
  )}&timestamp=${timestamp}&signature=${signature}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tmp_auth_code: code })
  });
  const payload = await response.json();

  if (!response.ok || payload.errcode !== 0) {
    throw new Error(payload.errmsg || `DingTalk login failed with status ${response.status}`);
  }

  return payload.user_info;
}

function dingtalkLoginUrl(req) {
  return `${req.protocol}://${req.get('host')}/api/auth/dingtalk`;
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

function sessionUserFromDb(user) {
  return {
    id: user.id,
    username: user.username,
    nick: user.nick || user.username,
    unionid: user.unionid,
    openid: user.openid,
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
