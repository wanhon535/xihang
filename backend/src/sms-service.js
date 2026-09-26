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
// 阿里云 RPC 签名（HMAC-SHA1 + Signature 参数）
// ---------------------------------------------------------------------------
// ⚠️ dysmsapi 走的是**经典 RPC 风格**签名：需要把 Signature 作为 query 参数
//    传出。它**不支持** `Authorization: aliyun_v3:` 的 ACS3 头（那是新版
//    OpenAPI 用的），用了会返回 400 `MissingSignature`。
//
//    踩坑记录（2026-09-26）：原先用 ACS3 头签名，网关被配好后首次真机联调
//    报 `SMS_UPSTREAM_MissingSignature` —— 因为 query 里带的是
//    `SignatureMethod=HMAC-SHA256` 却没有 `Signature`，阿里云从
//    SignatureMethod 判定应走经典签名，于是要求 Signature 参数。
//    换成下面的 HMAC-SHA1 + Signature query 后立即 OK。

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

function hmac1(key, input, encoding) {
  return crypto.createHmac('sha1', key).update(input, 'utf8').digest(encoding);
}

/**
 * 生成阿里云 dysmsapi 请求的公共参数与 URL（经典 RPC 签名）。
 *
 *   StringToSign = METHOD \n percentEncode("/") \n percentEncode(sortedQuery)
 *   Signature    = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))
 *
 * Signature 作为 query 参数随请求一起发送（不是 Authorization 头）。
 *
 * 注意：签名的 canonical query **不含** Signature 本身，但**包含**其它全部
 * 公共参数与业务参数，且这些参数必须与真正发出去的 query 完全一致。
 *
 * ⚠️ 方法必须是 **GET**。dysmsapi 的经典 RPC 签名固定用 `GET&%2F&...`
 *    作为 stringToSign 前缀；若按 POST 签，阿里云会返回
 *    `SignatureDoesNotMatch`（即使请求本身用 POST 发出）。
 *    实测验证：同一个签名用 GET 发 → 通过（报 SignatureNonceUsed 说明已验签
 *    成功），用 POST 发 → SignatureDoesNotMatch。
 *
 *    请求本身用 POST 发没问题（参数都在 query 里），但**签名里的 method 必须
 *    写 GET**，这是阿里云 RPC 签名的历史约定。
 */
function buildSignedHeaders({ params, accessKeyId, accessKeySecret, method = 'GET' }) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(16).toString('hex');

  const allParams = {
    ...params,
    Format: 'JSON',
    Version: DYSMS_API_VERSION,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Timestamp: timestamp
  };

  const canonicalQuery = Object.keys(allParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  // ⚠️ 关键：stringToSign 里的 canonicalQuery 要**再整体 percentEncode 一次**
  //    （阿里云文档叫「编码后的规范化查询字符串」）。即 `=`→`%3D`、`&`→`%26`。
  //    少了这一步会得到 SignatureDoesNotMatch。
  //    阿里云报错里会回显它自己算的 server stringToSign，形如
  //    `POST&%2F&AccessKeyId%3D...%26Action%3D...` —— 可直接对照排查。
  // ⚠️ 三段之间用 '&' 连接，**不是** '\n'！
  //    阿里云报错回显的 server stringToSign 形如
  //    `GET&%2F&AccessKeyId%3D...%26Action%3D...` —— 开头就是 `GET&%2F&`。
  //    用 '\n' 连接会得到 SignatureDoesNotMatch（内容一样，仅分隔符不同）。
  const stringToSign = [method, percentEncode('/'), percentEncode(canonicalQuery)].join('&');
  const signature = hmac1(`${accessKeySecret}&`, stringToSign, 'base64');

  return {
    url: `${DYSMS_ENDPOINT}?Signature=${percentEncode(signature)}&${canonicalQuery}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    nonce
  };
}

/**
 * 调用 dysmsapi（RPC 风格：参数全部放在 query string，POST 空 body）。
 */
async function callDysmsApi({ params, accessKeyId, accessKeySecret, timeoutMs = 8000 }) {
  const { url, headers } = buildSignedHeaders({ params, accessKeyId, accessKeySecret });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
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

/**
 * 判断是否「阿里云认可的中国人名」。
 *
 * 背景：模板 SMS_512081074 的 ${name} 绑定了「个人姓名」变量类型，
 * 阿里云在下发前会做值校验，只认中文人名。实测被拒的形态：
 *   wanhong / zhangsan / Zhang San / Alice Wong / E1024
 * 通过的形态：
 *   陈鑫明 / 王五 / 欧阳娜娜（含少数民族·间隔号：阿依古丽·买买提）
 *
 * 规则：2-20 个字符，仅允许中文汉字 + 「·」（少数民族姓名间隔号）。
 * 注意这是「能不能过阿里云校验」的近似判断，不是严格的姓名学判定 ——
 * 判不准时宁可回退（发得出去）也不要硬闯（整条失败）。
 */
export function isChinesePersonName(value) {
  const name = String(value || '').trim();
  if (!name) return false;
  if (name.length < 2 || name.length > 20) return false;
  return /^[\u4e00-\u9fa5]+(?:·[\u4e00-\u9fa5]+)*$/.test(name);
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

  // -----------------------------------------------------------------------
  // 非中文姓名「智能回退」（仅对绑了「个人姓名」变量类型的模板生效）
  // -----------------------------------------------------------------------
  // 模板 SMS_512081074（欢迎新员工）的 ${name} 在阿里云侧绑定了「个人姓名」
  // 变量类型，下发前会做值校验：只认中文人名（如「陈鑫明」）。
  // 传英文名/拼音/工号（wanhong、Zhang San、E1024）一律被拒：
  //   isv.TEMPLATE_PARAMS_ILLEGAL
  //   模版中的变量name(wanhong)不符合[个人姓名]的变量规范!
  //
  // 这是阿里云在【下发前】的校验，网关只是转发方，代码层改不了规则。
  // 但不能让整条短信失败 —— 通知发不出去比称呼不准更糟。
  // 所以这里做降级：非中文人名 → 换成中性称呼「同事」，保证送达。
  //
  // ⚠️ 2026-09-26 更新：后来新建了「字符串版本」模板（SMS_512580314）等，
  // 其 ${name} 是「字符串」类型，**英文名可以原样发**。
  // 故用白名单 SMS_NAME_STRING_TEMPLATES 区分：命中的模板跳过降级。
  // -----------------------------------------------------------------------
  const NAME_FALLBACK = '同事';
  const nameStringTemplates = String(process.env.SMS_NAME_STRING_TEMPLATES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 该模板的 ${name} 是「字符串」类型 → 英文名可原样发，不降级
  const nameIsStringType = nameStringTemplates.includes(finalTemplateCode);
  let nameFallback = null;
  if (safeParam.name && !nameIsStringType && !isChinesePersonName(safeParam.name)) {
    nameFallback = { from: safeParam.name, to: NAME_FALLBACK };
    safeParam.name = NAME_FALLBACK;
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
    phone: maskPhone(to),
    // 非中文人名降级留痕：原始值 + 实际发出去的值，便于追溯与告警
    nameFallback
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
