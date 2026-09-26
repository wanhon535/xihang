// 汐构短信网关 —— 传输鉴权层
// ---------------------------------------------------------------------------
// 外部系统（Python 脚本 / 任何服务）调用短信接口时的固定密钥鉴权。
//
// 方案：HMAC-SHA256 固定密钥 + 时间戳 + 随机数
//   header: X-SMS-Key      调用方标识（keyId，非密钥本身）
//   header: X-SMS-Timestamp  Unix 秒级时间戳
//   header: X-SMS-Nonce      随机串，防重放
//   header: X-SMS-Signature  hex(HMAC-SHA256(secret, stringToSign))
//
//   stringToSign = method \n path \n timestamp \n nonce \n sha256Hex(rawBody)
//
// 为什么不是「固定 token 明文比对」：
//   明文 token 一旦在日志/抓包里泄露即可被无限重放。HMAC 方案下，即使整个请求
//   被抓包，攻击者拿到的也是对这一次 body+时间戳的签名，无法改 body 重发，也
//   无法在时间窗（默认 300 秒）外重放，且 nonce 保证同窗口内不重复。
//
// 兼容性：若调用方确实只想用一个固定字符串（最简单场景），也支持
//   header: X-SMS-Token: <SMS_GATEWAY_TOKEN>
// 这条路径默认关闭，需显式设置 SMS_GATEWAY_ALLOW_SIMPLE_TOKEN=1 才启用。
//
// ===========================================================================
// 固定参数模式（钉钉侧专用）—— 2026-09-26 新增
// ---------------------------------------------------------------------------
// 场景：钉钉自定义机器人 / 宜搭连接器**算不了 HMAC 签名**，只能发固定请求。
//       但裸 token 一旦泄露就能无限群发短信（烧钱）。所以这里在「固定请求」
//       的基础上叠三道锁：
//
//   1. 固定 token      X-SMS-Token: <SMS_GATEWAY_FIXED_TOKEN>
//   2. 固定模板        只允许 SMS_GATEWAY_FIXED_TEMPLATE_CODES 里列的模板
//                      （默认只给欢迎新人 SMS_512081074），不许任意内容
//   3. 限流            按调用方分桶：每分钟 + 每天 双上限
//                      （令牌桶 + 日计数器，内存态）
//
//   配置（.env）：
//     SMS_GATEWAY_ALLOW_SIMPLE_TOKEN=1
//     SMS_GATEWAY_FIXED_TOKEN=<随机串>
//     SMS_GATEWAY_FIXED_TEMPLATE_CODES=SMS_512081074
//     SMS_GATEWAY_RATE_PER_MIN=10
//     SMS_GATEWAY_RATE_PER_DAY=200
//
//   调用方（钉钉侧）只需一个固定的请求：
//     POST /api/sms/send
//     X-SMS-Token: <固定串>
//     {"phone":"138...","templateParam":{"name":"张三"},
//      "requestId":"join-{钉钉userid}"}
//
//   注意：固定参数模式下 `templateCode` 若由请求传入，必须在白名单内；
//         白名单外的模板一律 403 拒绝。
// ===========================================================================

import crypto from 'node:crypto';

const MAX_SKEW_SECONDS = 300; // 时间戳容差 ±5 分钟
const NONCE_TTL_MS = MAX_SKEW_SECONDS * 1000;

// 已消费的 nonce（内存态，防时间窗内重放）。窗口短且无需跨重启存活。
const consumedNonces = new Map();

// ---------------------------------------------------------------------------
// 固定参数模式的限流桶（内存态，按 token 分桶）
//   perMin: Map<key, {windowStart, count}>
//   perDay: Map<key, {dayKey, count}>
// ---------------------------------------------------------------------------
const ratePerMin = new Map();
const ratePerDay = new Map();

function rateCheck(key, { perMin, perDay }) {
  const now = Date.now();
  const dayKey = new Date(now).toISOString().slice(0, 10);

  // 每分钟桶（固定窗口）
  const minuteWindow = Math.floor(now / 60000);
  const m = ratePerMin.get(key);
  if (!m || m.window !== minuteWindow) {
    ratePerMin.set(key, { window: minuteWindow, count: 1 });
  } else {
    if (perMin > 0 && m.count >= perMin) {
      return { ok: false, reason: 'minute', limit: perMin };
    }
    m.count += 1;
  }

  // 每天桶
  const d = ratePerDay.get(key);
  if (!d || d.dayKey !== dayKey) {
    ratePerDay.set(key, { dayKey, count: 1 });
  } else {
    if (perDay > 0 && d.count >= perDay) {
      return { ok: false, reason: 'day', limit: perDay };
    }
    d.count += 1;
  }

  return { ok: true };
}

/**
 * 固定参数模式的配置解析。返回 null 表示未启用。
 */
export function fixedTokenConfig(env = process.env) {
  const enabled = String(env.SMS_GATEWAY_ALLOW_SIMPLE_TOKEN || '') === '1';
  const token = (env.SMS_GATEWAY_FIXED_TOKEN || env.SMS_GATEWAY_TOKEN || '').trim();
  if (!enabled || !token) return null;

  const codes = (env.SMS_GATEWAY_FIXED_TEMPLATE_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    token,
    // 白名单为空 → 回落到「只允许服务端默认模板」，绝不放行任意模板
    templateCodes: codes,
    perMin: Number(env.SMS_GATEWAY_RATE_PER_MIN || 10) || 0,
    perDay: Number(env.SMS_GATEWAY_RATE_PER_DAY || 200) || 0
  };
}

/**
 * 校验固定参数模式下的模板白名单。
 * 白名单为空时只允许「不传 templateCode」（即走服务端默认模板）。
 */
export function checkTemplateAllowed(requestedCode, cfg, defaultCode = '') {
  const want = String(requestedCode || '').trim() || String(defaultCode || '').trim();

  if (cfg.templateCodes.length === 0) {
    // 没配白名单：只允许默认模板，且调用方不得自行指定
    if (String(requestedCode || '').trim()) {
      return { ok: false, allowed: [] };
    }
    return { ok: true, code: want };
  }
  if (!want || !cfg.templateCodes.includes(want)) {
    return { ok: false, allowed: cfg.templateCodes };
  }
  return { ok: true, code: want };
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function pruneNonces() {
  const now = Date.now();
  for (const [nonce, expiresAt] of consumedNonces) {
    if (expiresAt < now) consumedNonces.delete(nonce);
  }
}

/**
 * 网关密钥表。支持多把密钥并存（便于轮换：先加新的，切完再删旧的）。
 *
 * 配置方式（.env）：
 *   SMS_GATEWAY_KEYS=k1:secret1,k2:secret2
 * 或单密钥：
 *   SMS_GATEWAY_KEY_ID=xigou
 *   SMS_GATEWAY_KEY_SECRET=<随机长串>
 */
export function loadGatewayKeys(env = process.env) {
  const keys = new Map();

  const multi = (env.SMS_GATEWAY_KEYS || '').trim();
  if (multi) {
    for (const pair of multi.split(',')) {
      const idx = pair.indexOf(':');
      if (idx <= 0) continue;
      const id = pair.slice(0, idx).trim();
      const secret = pair.slice(idx + 1).trim();
      if (id && secret) keys.set(id, secret);
    }
  }

  const singleId = (env.SMS_GATEWAY_KEY_ID || '').trim();
  const singleSecret = (env.SMS_GATEWAY_KEY_SECRET || '').trim();
  if (singleId && singleSecret) keys.set(singleId, singleSecret);

  return keys;
}

export function gatewayConfigured(env = process.env) {
  if ((env.SMS_GATEWAY_KEYS || '').trim()) return true;
  if ((env.SMS_GATEWAY_KEY_ID || '').trim() && (env.SMS_GATEWAY_KEY_SECRET || '').trim()) return true;
  return false;
}

/**
 * 计算签名。供服务端校验，也供文档里的调用方示例复用同一算法。
 */
export function computeSignature({ secret, method, path, timestamp, nonce, rawBody = '' }) {
  const stringToSign = [
    String(method).toUpperCase(),
    String(path),
    String(timestamp),
    String(nonce),
    sha256Hex(String(rawBody))
  ].join('\n');
  return crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex');
}

/**
 * Express 中间件：校验短信网关的传输鉴权。
 *
 * 注意 rawBody：签名基于「原始字节」。Express 的 express.json() 会重建对象，
 * 因此本中间件必须在 json 解析之前拿到原始 body（见 server.js 的挂载方式），
 * 由调用方把 rawBody 挂在 req.rawBody 上传进来。
 */
export function createSmsGatewayAuth(env = process.env) {
  return function smsGatewayAuth(req, res, next) {
    const keys = loadGatewayKeys(env);

    if (keys.size === 0) {
      res.status(503).json({
        ok: false,
        code: 'SMS_GATEWAY_NOT_CONFIGURED',
        message: '短信网关鉴权密钥未配置，请联系管理员在服务器 .env 中设置 SMS_GATEWAY_KEY_ID / SMS_GATEWAY_KEY_SECRET。'
      });
      return;
    }

    // 简易固定 token 模式（默认关闭）
    // 钉钉侧走这条路：固定 token + 模板白名单 + 限流
    if (String(env.SMS_GATEWAY_ALLOW_SIMPLE_TOKEN || '') === '1' && env.SMS_GATEWAY_TOKEN) {
      const provided = req.get('X-SMS-Token') || '';
      if (safeEqual(provided, env.SMS_GATEWAY_TOKEN)) {
        next();
        return;
      }
    }

    // 固定参数模式（钉钉侧专用）：固定 token + 模板白名单 + 限流
    const fixedCfg = fixedTokenConfig(env);
    if (fixedCfg) {
      const provided = req.get('X-SMS-Token') || '';
      if (provided && safeEqual(provided, fixedCfg.token)) {
        // 限流：先按 token 分桶检查
        const bucket = `fixed:${crypto.createHash('sha256').update(provided).digest('hex').slice(0, 12)}`;
        const rate = rateCheck(bucket, fixedCfg);
        if (!rate.ok) {
          res.status(429).json({
            ok: false,
            code: rate.reason === 'minute' ? 'SMS_RATE_LIMIT_MINUTE' : 'SMS_RATE_LIMIT_DAY',
            message:
              rate.reason === 'minute'
                ? `触发限流：每分钟最多 ${rate.limit} 条，请稍后重试。`
                : `触发限流：每天最多 ${rate.limit} 条，请明日再试。`
          });
          return;
        }

        // 模板白名单：在此拦掉，避免有人拿固定 token 发任意内容
        const allowed = checkTemplateAllowed(req.body?.templateCode, fixedCfg, env.ALIYUN_SMS_TEMPLATE_CODE || '');
        if (!allowed.ok) {
          res.status(403).json({
            ok: false,
            code: 'SMS_TEMPLATE_NOT_ALLOWED',
            message: `固定参数模式不允许该短信模板。允许的模板：${allowed.allowed.join(', ') || '（仅服务端默认模板）'}`
          });
          return;
        }

        // 固定模式下强制使用白名单解析出的模板，覆盖请求里的值
        req.body = { ...(req.body || {}), templateCode: allowed.code };
        req.smsCaller = { keyId: 'fixed-token', mode: 'fixed' };
        next();
        return;
      }
      // 带了 token 但不对 → 直接拒绝，不再往下走 HMAC（避免探测）
      if (provided) {
        res.status(401).json({
          ok: false,
          code: 'SMS_AUTH_BAD_TOKEN',
          message: '固定 token 不正确。'
        });
        return;
      }
    }

    const keyId = (req.get('X-SMS-Key') || '').trim();
    const timestamp = (req.get('X-SMS-Timestamp') || '').trim();
    const nonce = (req.get('X-SMS-Nonce') || '').trim();
    const signature = (req.get('X-SMS-Signature') || '').trim();

    if (!keyId || !timestamp || !nonce || !signature) {
      res.status(401).json({
        ok: false,
        code: 'SMS_AUTH_MISSING',
        message: '缺少鉴权头：需要 X-SMS-Key / X-SMS-Timestamp / X-SMS-Nonce / X-SMS-Signature。'
      });
      return;
    }

    const secret = keys.get(keyId);
    if (!secret) {
      res.status(401).json({
        ok: false,
        code: 'SMS_AUTH_UNKNOWN_KEY',
        message: '未知的调用方标识（X-SMS-Key）。'
      });
      return;
    }

    // 时间戳容差
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      res.status(401).json({ ok: false, code: 'SMS_AUTH_BAD_TIMESTAMP', message: '时间戳格式不正确。' });
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) {
      res.status(401).json({
        ok: false,
        code: 'SMS_AUTH_EXPIRED',
        message: `请求已过期：时间戳偏差超过 ${MAX_SKEW_SECONDS} 秒，请校准调用方服务器时间。`
      });
      return;
    }

    // 签名比对（必须用原始 body）
    const rawBody = req.rawBody !== undefined && req.rawBody !== null ? req.rawBody : '';
    const expected = computeSignature({
      secret,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      timestamp,
      nonce,
      rawBody
    });

    if (!safeEqual(signature, expected)) {
      res.status(401).json({
        ok: false,
        code: 'SMS_AUTH_BAD_SIGNATURE',
        message: '签名校验失败。请检查密钥、时间戳、nonce 以及是否使用了原始请求体参与签名。'
      });
      return;
    }

    // 防重放：同一 nonce 在时间窗内只能消费一次
    pruneNonces();
    const nonceKey = `${keyId}:${nonce}`;
    if (consumedNonces.has(nonceKey)) {
      res.status(409).json({
        ok: false,
        code: 'SMS_AUTH_REPLAY',
        message: '重复的请求（nonce 已被使用），请更换 nonce 重试。'
      });
      return;
    }
    consumedNonces.set(nonceKey, Date.now() + NONCE_TTL_MS);

    req.smsCaller = { keyId };
    next();
  };
}
