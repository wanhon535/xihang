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

import crypto from 'node:crypto';

const MAX_SKEW_SECONDS = 300; // 时间戳容差 ±5 分钟
const NONCE_TTL_MS = MAX_SKEW_SECONDS * 1000;

// 已消费的 nonce（内存态，防时间窗内重放）。窗口短且无需跨重启存活。
const consumedNonces = new Map();

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
    if (String(env.SMS_GATEWAY_ALLOW_SIMPLE_TOKEN || '') === '1' && env.SMS_GATEWAY_TOKEN) {
      const provided = req.get('X-SMS-Token') || '';
      if (safeEqual(provided, env.SMS_GATEWAY_TOKEN)) {
        next();
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
