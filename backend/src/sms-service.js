// 汐构短信网关 —— 服务层实现
// ---------------------------------------------------------------------------
// 对外提供「接收外部系统触发短信发送」的能力。外部调用方（Python/任意语言）
// 通过 HTTP POST /api/sms/send 触发，用固定密钥（HMAC-SHA256）做传输鉴权。
//
// 设计要点：
//   1. 直接实现阿里云 dysmsapi 的 RPC 签名（V3 风格 HMAC-SHA256），不引入
//      aliyun SDK，避免额外依赖 —— 本仓库现有代码风格也是手写签名（见 server.js
//      的钉钉 API 调用）。
//   2. 凭证优先从 system_settings 读取（管理中枢可配），回落到 .env 里的
//      ALIYUN_SMS_* / ALIYUN_ACCESS_KEY_*，方便运维不改库就能起飞。
//   3. 所有密钥在日志中一律脱敏；AccessKeySecret 永不回显。
//   4. 发送前做参数校验 + 手机号规范化；手机号在回执/日志里脱敏。
//   5. 幂等由调用方传 outId（可选）；本层不强制，但会把 outId 透传给阿里云，
//      便于在阿里云控制台按 outId 追溯。

import crypto from 'node:crypto';

const DYSMS_API_VERSION = '2017-05-25';
const DYSMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const DYSMS_PRODUCT = 'Dysmsapi';
const DYSMS_ACTION_SEND = 'SendSms';
const DYSMS_ACTION_QUERY = 'QuerySendDetails';

// 中国大陆手机号：1 开头，第二位 3-9，共 11 位
const CN_MOBILE_RE = /^1[3-9]\d{9}$/;

export class SmsError extends Error {
  constructor(message, { code = 'SMS_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message);
    this.name = 'SmsError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 凭证解析
// ---------------------------------------------------------------------------

/**
 * 解析阿里云短信凭证。优先取系统设置（库里配的），否则回落到环境变量。
 * 注意：accessKeySecret 只在此处短暂持有，绝不写入日志或响应体。
 */
export async function resolveSmsCredentials({ settings = null, getSecret = null } = {}) {
  const s = settings || {};
  let accessKeySecret = '';
  if (getSecret) {
    accessKeySecret = (await getSecret('smsAccessKeySecret')) || '';
  }

  const accessKeyId = s.smsAccessKeyId || process.env.ALIYUN_SMS_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID || '';
  if (!accessKeySecret) {
    accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET || '';
  }

  const signName = s.smsSignName || process.env.ALIYUN_SMS_SIGN_NAME || '';
  const templateCode = s.smsTemplateCode || process.env.ALIYUN_SMS_TEMPLATE_CODE || '';

  return { accessKeyId, accessKeySecret, signName, templateCode };
}

/** 凭证是否齐备（用于健康检查/启动自检，不泄露任何值） */
export function smsCredentialsStatus({ accessKeyId, accessKeySecret, signName, templateCode }) {
  return {
    accessKeyConfigured: Boolean(accessKeyId && accessKeySecret),
    signNameConfigured: Boolean(signName),
    defaultTemplateConfigured: Boolean(templateCode)
  };
}

// ---------------------------------------------------------------------------
// 阿里云 RPC 签名（HMAC-SHA256 / V3 风格）
// ---------------------------------------------------------------------------

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac256(key, input, encoding) {
  return crypto.createHmac('sha256', key).update(input, 'utf8').digest(encoding);
}

/**
 * 生成阿里云 dysmsapi 请求的公共参数（含 Authorization 头）。
 *
 * 采用 RPC 风格 V3 签名：
 *   CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQueryString \n
 *                      CanonicalHeaders \n SignedHeaders \n HashedPayload
 *   StringToSign     = Algorithm \n Timestamp \n Scope \n Hash(CanonicalRequest)
 *   Signature        = HMAC-SHA256(SigningKey, StringToSign)
 */
function buildSignedHeaders({ params, accessKeyId, accessKeySecret, body = '' }) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(16).toString('hex');

  const allParams = {
    ...params,
    Format: 'JSON',
    Version: DYSMS_API_VERSION,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA256',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Timestamp: timestamp
  };

  const canonicalQuery = Object.keys(allParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  const hashedPayload = sha256Hex(body);
  const canonicalHeaders = `host:dysmsapi.aliyuncs.com\nx-acs-action:${params.Action}\nx-acs-version:${DYSMS_API_VERSION}\n`;
  const signedHeaders = 'host;x-acs-action;x-acs-version';
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, hashedPayload].join('\n');

  const dateScope = timestamp.slice(0, 10); // yyyy-MM-dd
  const signingKey = hmac256(accessKeySecret, `aliyun_v3:${accessKeyId}:${dateScope}`, 'buffer');
  const signature = hmac256(signingKey, canonicalRequest, 'hex');

  const authorization =
    `aliyun_v3:HmacSHA256 Credential=${accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${DYSMS_ENDPOINT}?${canonicalQuery}`,
    headers: {
      Authorization: authorization,
      'x-acs-action': params.Action,
      'x-acs-version': DYSMS_API_VERSION,
      'x-acs-date': timestamp,
      'x-acs-content-sha256': hashedPayload,
      'content-type': 'application/x-www-form-urlencoded'
    },
    nonce
  };
}

/**
 * 调用 dysmsapi（RPC 风格：参数全部放在 query string，POST 空 body）。
 */
async function callDysmsApi({ params, accessKeyId, accessKeySecret, timeoutMs = 8000 }) {
  const { url, headers } = buildSignedHeaders({ params, accessKeyId, accessKeySecret, body: '' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SmsError('阿里云返回了非 JSON 响应。', {
        code: 'SMS_UPSTREAM_BAD_RESPONSE',
        httpStatus: 502,
        detail: text.slice(0, 300)
      });
    }
    return { httpStatus: response.status, payload };
  } catch (error) {
    if (error instanceof SmsError) throw error;
    if (error.name === 'AbortError') {
      throw new SmsError('调用阿里云短信接口超时。', { code: 'SMS_UPSTREAM_TIMEOUT', httpStatus: 504 });
    }
    throw new SmsError(`调用阿里云短信接口失败：${error.message}`, {
      code: 'SMS_UPSTREAM_UNREACHABLE',
      httpStatus: 502
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 手机号工具
// ---------------------------------------------------------------------------

export function normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s\-()]/g, '');
  const withoutPrefix = cleaned.startsWith('+86') ? cleaned.slice(3) : cleaned;
  return withoutPrefix;
}

export function validatePhone(raw) {
  const phone = normalizePhone(raw);
  if (!phone) {
    throw new SmsError('手机号不能为空。', { code: 'SMS_PHONE_EMPTY' });
  }
  if (!CN_MOBILE_RE.test(phone)) {
    throw new SmsError(`手机号格式不正确：${maskPhone(phone)}`, { code: 'SMS_PHONE_INVALID' });
  }
  return phone;
}

/** 日志安全的手机号脱敏：13800138000 -> 138****8000 */
export function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length < 7) return '***';
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 核心：发送短信
// ---------------------------------------------------------------------------

/**
 * 发送单条短信。
 *
 * @param {object}  args
 * @param {string}  args.phone          收信号码（必填）
 * @param {object}  args.templateParam  模板变量，如 { name: '张三', code: '123456' }
 * @param {string} [args.templateCode]  覆盖默认模板
 * @param {string} [args.signName]      覆盖默认签名
 * @param {string} [args.outId]         调用方追踪 ID（透传阿里云）
 * @param {object}  args.credentials    resolvedSmsCredentials() 的返回值
 * @returns {Promise<{bizId, code, message, requestId, phone}>}
 */
export async function sendSms({ phone, templateParam = {}, templateCode, signName, outId, credentials }) {
  const { accessKeyId, accessKeySecret } = credentials || {};
  if (!accessKeyId || !accessKeySecret) {
    throw new SmsError('短信服务未配置 AccessKey，请在管理中枢「系统设置」或服务器 .env 中配置。', {
      code: 'SMS_NOT_CONFIGURED',
      httpStatus: 503
    });
  }

  const to = validatePhone(phone);
  const finalSignName = (signName || credentials.signName || '').trim();
  const finalTemplateCode = (templateCode || credentials.templateCode || '').trim();

  if (!finalSignName) {
    throw new SmsError('短信签名未配置。', { code: 'SMS_SIGN_NAME_MISSING', httpStatus: 503 });
  }
  if (!finalTemplateCode) {
    throw new SmsError('短信模板 Code 未配置。', { code: 'SMS_TEMPLATE_MISSING', httpStatus: 503 });
  }
  if (templateParam === null || typeof templateParam !== 'object' || Array.isArray(templateParam)) {
    throw new SmsError('templateParam 必须是 JSON 对象。', { code: 'SMS_TEMPLATE_PARAM_INVALID' });
  }

  // 模板变量值统一转字符串（阿里云要求全部为字符串），并限制长度防注入
  const safeParam = {};
  for (const [key, value] of Object.entries(templateParam)) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) {
      throw new SmsError(`模板变量名不合法：${key}`, { code: 'SMS_TEMPLATE_PARAM_INVALID' });
    }
    safeParam[key] = String(value ?? '').slice(0, 200);
  }

  const params = {
    Action: DYSMS_ACTION_SEND,
    PhoneNumbers: to,
    SignName: finalSignName,
    TemplateCode: finalTemplateCode
  };
  if (Object.keys(safeParam).length) {
    params.TemplateParam = JSON.stringify(safeParam);
  }
  if (outId) {
    params.OutId = String(outId).slice(0, 255);
  }

  const { payload } = await callDysmsApi({ params, accessKeyId, accessKeySecret });

  const code = payload?.Code || payload?.code || '';
  if (code !== 'OK') {
    throw new SmsError(payload?.Message || '阿里云短信发送失败。', {
      code: `SMS_UPSTREAM_${code || 'UNKNOWN'}`,
      httpStatus: 502,
      detail: { upstreamCode: code, upstreamMessage: payload?.Message || '' }
    });
  }

  return {
    bizId: payload.BizId || '',
    code,
    message: payload.Message || 'OK',
    requestId: payload.RequestId || '',
    phone: maskPhone(to)
  };
}

/**
 * 查询发送回执。SendStatus: 1=在途 2=失败 3=已送达
 * 用于「到底送达没有」这类问题，不要拿 sendSms 的响应当送达证明。
 */
export async function querySendDetail({ phone, sendDate, bizId, credentials, pageSize = 10, currentPage = 1 }) {
  const { accessKeyId, accessKeySecret } = credentials || {};
  if (!accessKeyId || !accessKeySecret) {
    throw new SmsError('短信服务未配置 AccessKey。', { code: 'SMS_NOT_CONFIGURED', httpStatus: 503 });
  }

  const to = validatePhone(phone);
  const date = String(sendDate || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(date)) {
    throw new SmsError('sendDate 必须是 yyyyMMdd 或 yyyy-MM-dd 格式。', { code: 'SMS_SEND_DATE_INVALID' });
  }

  const params = {
    Action: DYSMS_ACTION_QUERY,
    PhoneNumber: to,
    SendDate: date,
    PageSize: String(pageSize),
    CurrentPage: String(currentPage)
  };
  if (bizId) params.BizId = String(bizId);

  const { payload } = await callDysmsApi({ params, accessKeyId, accessKeySecret });

  const code = payload?.Code || '';
  if (code !== 'OK') {
    throw new SmsError(payload?.Message || '查询回执失败。', {
      code: `SMS_UPSTREAM_${code || 'UNKNOWN'}`,
      httpStatus: 502,
      detail: { upstreamCode: code }
    });
  }

  const list = payload?.SmsSendDetailDTOs?.SmsSendDetailDTO || [];
  const total = Number(payload?.TotalCount || 0);

  return {
    totalCount: total,
    // totalCount=1 但明细为空数组 = 回执尚未落库，稍后再查，不是失败
    pending: total > 0 && list.length === 0,
    details: list.map((item) => ({
      phone: maskPhone(item.PhoneNum || to),
      sendStatus: Number(item.SendStatus || 0),
      sendStatusText: { 1: '在途', 2: '失败', 3: '已送达' }[Number(item.SendStatus)] || '未知',
      errCode: item.ErrCode || '',
      sendDate: item.SendDate || '',
      receiveDate: item.ReceiveDate || '',
      content: item.Content || ''
    }))
  };
}
