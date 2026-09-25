// 钉钉通讯录只读同步：用企业内部应用的 AppKey/AppSecret 拉取部门树和在职员工名单，
// 为每个人预建/刷新汐航本地账号（角色仍由管理员手动分配，从不回写钉钉），并把不
// 再出现在花名册里的账号标记为禁用。和 server.js 里 OAuth 登录用的钉钉应用是两回
// 事：那个是用户扫码登录用的，这个是服务端到服务端的通讯录管理只读权限。
import { getAccessToken, callLegacyApi } from './dingtalk-api.js';

const ROOT_DEPT_ID = 1;
const API_BASE = 'https://oapi.dingtalk.com';

export async function syncDingTalkRoster({ appKey, appSecret, corpId, db }) {
  if (!appKey || !appSecret) {
    throw new Error('尚未配置通讯录同步应用的 AppKey/AppSecret。');
  }

  const accessToken = await getAccessToken(appKey, appSecret);
  const deptIds = await collectDepartmentIds(accessToken, ROOT_DEPT_ID);
  const users = await collectDepartmentUsers(accessToken, deptIds);

  let created = 0;
  let updated = 0;
  const activeUserIds = [];

  for (const user of users) {
    if (!user.userid) continue;
    activeUserIds.push(user.userid);
    const existing = await db.findUserByDingTalkUserId(corpId, user.userid);
    await db.upsertRosterUser({
      dingtalkUserId: user.userid,
      dingtalkCorpId: corpId,
      nick: user.name || '',
      unionid: user.unionid || ''
    });
    if (existing) updated += 1;
    else created += 1;
  }

  const disabled = await db.disableStaleDingTalkUsers(corpId, activeUserIds);

  return { total: activeUserIds.length, created, updated, disabled };
}

async function collectDepartmentIds(accessToken, rootDeptId) {
  const seen = new Set([rootDeptId]);
  const queue = [rootDeptId];

  while (queue.length) {
    const deptId = queue.shift();
    const payload = await callLegacyApi(`${API_BASE}/topapi/v2/department/listsub?access_token=${accessToken}`, {
      dept_id: deptId
    });
    const subDepts = payload.result || [];
    for (const dept of subDepts) {
      if (!seen.has(dept.dept_id)) {
        seen.add(dept.dept_id);
        queue.push(dept.dept_id);
      }
    }
  }

  return [...seen];
}

async function collectDepartmentUsers(accessToken, deptIds) {
  const byUserId = new Map();

  for (const deptId of deptIds) {
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
      const payload = await callLegacyApi(`${API_BASE}/topapi/v2/user/list?access_token=${accessToken}`, {
        dept_id: deptId,
        cursor,
        size: 100
      });
      const result = payload.result || {};
      for (const user of result.list || []) {
        if (user.userid) byUserId.set(user.userid, user);
      }
      hasMore = Boolean(result.has_more);
      cursor = result.next_cursor || 0;
    }
  }

  return [...byUserId.values()];
}
