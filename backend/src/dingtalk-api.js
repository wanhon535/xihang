// Shared helpers for calling DingTalk's server-to-server (企业内部应用) APIs:
// getting a corp app access_token and making authenticated calls with it.
// Used by both the roster sync (通讯录管理) and wiki sync (知识库) modules,
// which are otherwise unrelated features that just happen to share this
// access-token plumbing.
const API_BASE = 'https://oapi.dingtalk.com';

export async function getAccessToken(appKey, appSecret) {
  const url = `${API_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const payload = await callLegacyApi(url);
  if (!payload.access_token) {
    throw new Error(payload.errmsg || '获取钉钉 access_token 失败。');
  }
  return payload.access_token;
}

// The older oapi.dingtalk.com family (used by gettoken and the 通讯录 topapi
// endpoints) reports errors via a 200-status errcode/errmsg body.
export async function callLegacyApi(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (payload.errcode) {
    throw new Error(`钉钉接口返回错误（${payload.errcode}）：${payload.errmsg || '未知错误'}`);
  }
  return payload;
}

// The newer api.dingtalk.com family (used by the v2.0/wiki endpoints) takes
// the access token as a header and reports errors via HTTP status + a
// {code, message} body instead of errcode/errmsg.
export async function callOpenApi(path, accessToken, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  const url = `https://api.dingtalk.com${path}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { 'x-acs-dingtalk-access-token': accessToken }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`钉钉接口返回错误（${response.status}）：${payload.message || payload.code || '未知错误'}`);
  }
  return payload;
}
