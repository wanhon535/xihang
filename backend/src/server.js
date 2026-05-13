import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import {
  cleanExpiredSsoTickets,
  consumeSsoTicket,
  createSsoTicket,
  findUserByUsername,
  getSiteGroups,
  initDatabase,
  replaceSiteGroups,
  touchUserLogin,
  upsertDingTalkUser
} from './db.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const redirectUri = process.env.DINGTALK_REDIRECT_URI || `http://localhost:${port}/api/auth/dingtalk/callback`;
const allowedUnionIds = parseList(process.env.ALLOWED_DINGTALK_UNION_IDS);
const adminUnionIds = parseList(process.env.ADMIN_DINGTALK_UNION_IDS);
const adminNicks = parseList(process.env.ADMIN_DINGTALK_NICKS || 'admin').map((item) => item.toLowerCase());
const ssoTicketTtlSeconds = Number(process.env.SSO_TICKET_TTL_SECONDS || 120);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: frontendOrigin,
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
    nick: user.nick,
    unionid: user.unionid,
    openid: user.openid,
    username: user.username,
    role: user.role || (isAdmin(user) ? 'admin' : 'member')
  };
}

function requireLogin(req, res, next) {
  if (req.session.user) {
    next();
    return;
  }

  res.status(401).json({ ok: false, message: '请先登录。' });
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.session.user)) {
    next();
    return;
  }

  res.status(403).json({ ok: false, message: '没有后台权限。' });
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ ok: true, user: safeUser(req.session.user), loginUrl: `${req.protocol}://${req.get('host')}/api/auth/dingtalk` });
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
    req.session.user = sessionUserFromDb(storedUser);
    res.redirect(frontendOrigin);
  } catch (error) {
    res.redirect(`${frontendOrigin}/login.html?error=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tidesail_sid');
    res.json({ ok: true });
  });
});

app.post('/api/auth/password-login', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const user = await findUserByUsername(username);

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        res.status(401).json({ ok: false, message: '账号或密码错误。' });
        return;
      }

      await touchUserLogin(user.id);
      req.session.user = sessionUserFromDb(user);
      res.json({ ok: true, user: safeUser(req.session.user) });
    })
    .catch((error) => {
      res.status(500).json({ ok: false, message: error.message || '登录失败。' });
    });
});

app.get('/api/nav/groups', requireLogin, async (req, res, next) => {
  try {
    res.json({ ok: true, groups: await getSiteGroups() });
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
    const expiresAt = new Date(Date.now() + ssoTicketTtlSeconds * 1000);
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

app.get('/api/admin/groups', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, groups: await getSiteGroups() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/groups', requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, groups: await replaceSiteGroups(req.body.groups) });
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

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sessionUserFromDb(user) {
  return {
    id: user.id,
    username: user.username,
    nick: user.nick || user.username,
    unionid: user.unionid,
    openid: user.openid,
    role: user.role || 'member'
  };
}

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`TideSail API is running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error.message);
    process.exit(1);
  });
