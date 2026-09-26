// 汐构短信网关 —— 端到端自测（不真实发短信，只验证鉴权与错误路径）
import crypto from 'node:crypto';

const BASE = process.env.SMS_TEST_BASE || 'http://127.0.0.1:9989';
const KEY_ID = process.env.SMS_GATEWAY_KEY_ID;
const SECRET = process.env.SMS_GATEWAY_KEY_SECRET;

if (!KEY_ID || !SECRET) {
  console.error('缺少 SMS_GATEWAY_KEY_ID / SMS_GATEWAY_KEY_SECRET');
  process.exit(1);
}

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function sign({ method, path, timestamp, nonce, rawBody }) {
  const sts = [method.toUpperCase(), path, String(timestamp), String(nonce), sha256Hex(rawBody)].join('\n');
  return crypto.createHmac('sha256', SECRET).update(sts, 'utf8').digest('hex');
}

async function call(path, body, { badSign = false, skew = 0, reuseNonce = null, noAuth = false } = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000) + skew;
  const nonce = reuseNonce || crypto.randomBytes(12).toString('hex');
  const headers = { 'Content-Type': 'application/json' };
  if (!noAuth) {
    headers['X-SMS-Key'] = KEY_ID;
    headers['X-SMS-Timestamp'] = String(timestamp);
    headers['X-SMS-Nonce'] = nonce;
    headers['X-SMS-Signature'] = badSign ? 'deadbeef'.repeat(8) : sign({ method: 'POST', path, timestamp, nonce, rawBody });
  }
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: rawBody || undefined });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json, nonce };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name} ${extra}`); fail++; }
}

console.log('=== 1. 健康检查（无需鉴权）===');
{
  const r = await fetch(`${BASE}/api/sms/health`);
  const j = await r.json();
  console.log('   ', JSON.stringify(j));
  check('health 200', r.status === 200);
  check('service 名正确', j.service === 'xigou-sms-gateway');
  check('网关密钥已配置', j.gatewayAuthConfigured === true);
}

console.log('=== 2. 无鉴权头 → 401 ===');
{
  const r = await call('/api/sms/send', { phone: '13800138000' }, { noAuth: true });
  check('401', r.status === 401, `got ${r.status}`);
  check('code=SMS_AUTH_MISSING', r.json?.code === 'SMS_AUTH_MISSING', JSON.stringify(r.json));
}

console.log('=== 3. 错误签名 → 401 ===');
{
  const r = await call('/api/sms/send', { phone: '13800138000' }, { badSign: true });
  check('401', r.status === 401, `got ${r.status}`);
  check('code=SMS_AUTH_BAD_SIGNATURE', r.json?.code === 'SMS_AUTH_BAD_SIGNATURE', JSON.stringify(r.json));
}

console.log('=== 4. 过期时间戳（-600s）→ 401 ===');
{
  const r = await call('/api/sms/send', { phone: '13800138000' }, { skew: -600 });
  check('401', r.status === 401, `got ${r.status}`);
  check('code=SMS_AUTH_EXPIRED', r.json?.code === 'SMS_AUTH_EXPIRED', JSON.stringify(r.json));
}

console.log('=== 5. nonce 重放 → 409 ===');
{
  const first = await call('/api/sms/send', { phone: '13800138000' });
  const replay = await call('/api/sms/send', { phone: '13800138000' }, { reuseNonce: first.nonce });
  check('首次不是 409', first.status !== 409, `got ${first.status}`);
  check('重放 409', replay.status === 409, `got ${replay.status}`);
  check('code=SMS_AUTH_REPLAY', replay.json?.code === 'SMS_AUTH_REPLAY', JSON.stringify(replay.json));
}

console.log('=== 6. 篡改 body（用旧签名）→ 401 ===');
{
  // 对 body A 签名，但发 body B
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString('hex');
  const sigForA = sign({ method: 'POST', path: '/api/sms/send', timestamp, nonce, rawBody: JSON.stringify({ phone: '13800138000' }) });
  const res = await fetch(`${BASE}/api/sms/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SMS-Key': KEY_ID,
      'X-SMS-Timestamp': String(timestamp),
      'X-SMS-Nonce': nonce,
      'X-SMS-Signature': sigForA
    },
    body: JSON.stringify({ phone: '13900139000' }) // 篡改后的 body
  });
  const j = await res.json();
  check('401 拒绝篡改', res.status === 401, `got ${res.status}`);
  check('code=SMS_AUTH_BAD_SIGNATURE', j?.code === 'SMS_AUTH_BAD_SIGNATURE', JSON.stringify(j));
}

console.log('=== 7. 合法签名 + 非法手机号 → 业务错误（证明鉴权已通过）===');
{
  const r = await call('/api/sms/send', { phone: '12345' });
  // 说明：鉴权通过后，服务会先检查阿里云凭证是否已配置（未配置则 SMS_NOT_CONFIGURED），
  // 凭证齐备时才会走到手机号校验（SMS_PHONE_INVALID）。
  // 两种都是「业务错误」而非鉴权错误，证明签名校验已放行。
  const authPassed = r.status !== 401 && !String(r.json?.code || '').startsWith('SMS_AUTH_');
  check('鉴权已放行（非 401 且非 SMS_AUTH_*）', authPassed, JSON.stringify(r.json));
  check(
    'code ∈ {SMS_NOT_CONFIGURED, SMS_PHONE_INVALID}',
    ['SMS_NOT_CONFIGURED', 'SMS_PHONE_INVALID'].includes(r.json?.code),
    JSON.stringify(r.json)
  );
}

console.log('=== 8. 合法签名 + 缺 phone → 400 ===');
{
  const r = await call('/api/sms/send', {});
  check('400', r.status === 400, `got ${r.status}`);
  check('code=SMS_PHONE_EMPTY', r.json?.code === 'SMS_PHONE_EMPTY', JSON.stringify(r.json));
}

console.log();
console.log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
