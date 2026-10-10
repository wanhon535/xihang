// 站点矩阵（管理中枢 → 站点矩阵）的保存策略。
//
// 为什么单独抽一个模块：这套逻辑踩过一次真实的坑 ——
// 原来 `saveGroups()` 保存成功后执行 `groups = payload.groups`，把本地状态换成服务端副本。
// 服务端 `replaceSiteGroups()` 是「删全表 + 全量重插」，并且会**丢掉没填完整（缺名称或地址）的入口**，
// 于是本地那个刚新增、还没填完的入口直接从状态里消失；而自动保存为了不抢输入焦点又不会重建 DOM，
// 用户眼前那张卡片还在，他接着往里填字 —— 填进的是**已经脱离 groups 的孤儿对象**，
// 后续任何保存都不再包含它。表现就是「保存了，但没展示」。
//
// 现在的策略：
// 1. 本地状态是唯一事实来源（服务端返回只用来回填 id / 刷新快照，绝不整体替换对象）；
// 2. 没填完的新入口不进 payload（后端反正会丢），但**留在本地**让用户接着填；
// 3. 曾经存过、现在被改到不完整的入口，用「上一次保存成功的版本」占位，
//    避免后端全表重建时把它误删；
// 4. payload 无变化时自动保存直接跳过，不做无意义的全表重建。

const VISIBILITIES = ['all', 'admins', 'roles', 'users'];

const trim = (value) => String(value ?? '').trim();

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return text.split(/[,，]/);
      }
    }
    return text.split(/[,，]/);
  }
  return [];
}

export function isCompleteSite(site) {
  return Boolean(trim(site?.name) && trim(site?.url));
}

export function isCompleteGroup(group) {
  return Boolean(trim(group?.name));
}

// 只保留后端真的会落库的字段，避免把前端临时状态（快照等）传上去。
export function normalizeSiteForSave(site) {
  return {
    name: trim(site?.name),
    url: trim(site?.url),
    iconUrl: trim(site?.iconUrl ?? site?.icon_url),
    description: trim(site?.description),
    tags: toList(site?.tags).map(trim).filter(Boolean),
    visibility: VISIBILITIES.includes(trim(site?.visibility)) ? trim(site.visibility) : 'all',
    allowedRoles: [...new Set(toList(site?.allowedRoles).map(trim).filter((role) => role === 'admin' || role === 'member'))],
    allowedUserIds: [...new Set(toList(site?.allowedUserIds).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  };
}

export function createSiteMatrixState() {
  return { snapshots: new WeakMap(), signature: '' };
}

// 载入服务端数据后调用：给已成形的分组/入口记下「最后保存成功的样子」。
export function primeSiteMatrixState(groups, state) {
  for (const group of groups || []) {
    if (isCompleteGroup(group)) {
      state.snapshots.set(group, { name: trim(group.name), description: trim(group.description) });
    }
    for (const site of group.sites || []) {
      if (isCompleteSite(site)) state.snapshots.set(site, normalizeSiteForSave(site));
    }
  }
  state.signature = JSON.stringify(buildSavePayload(groups, state).groups);
  return state.signature;
}

// 生成本次要提交给后端的 payload，并如实汇报「哪些没入库」。
// order 与 payload 分组/入口一一对应，保存成功后用它回填 id。
export function buildSavePayload(groups, state) {
  const pending = { sites: 0, groups: 0, preserved: 0 };
  const payloadGroups = [];
  const order = [];

  for (const group of groups || []) {
    const payloadSites = [];
    const orderSites = [];
    for (const site of group.sites || []) {
      if (isCompleteSite(site)) {
        payloadSites.push(normalizeSiteForSave(site));
        orderSites.push(site);
        continue;
      }
      const snapshot = state.snapshots.get(site);
      if (snapshot) {
        // 改到一半（或被清空）：先用上次保存成功的值占位，别让后端把这条删掉。
        payloadSites.push(snapshot);
        orderSites.push(site);
        pending.preserved += 1;
      } else {
        // 全新且没填完：不入库，但保留在本地等用户填完。
        pending.sites += 1;
      }
    }

    if (isCompleteGroup(group)) {
      payloadGroups.push({ name: trim(group.name), description: trim(group.description), sites: payloadSites });
      order.push({ group, sites: orderSites });
      continue;
    }
    const groupSnapshot = state.snapshots.get(group);
    if (groupSnapshot) {
      payloadGroups.push({ ...groupSnapshot, sites: payloadSites });
      order.push({ group, sites: orderSites });
      pending.preserved += 1;
    } else {
      pending.groups += 1;
    }
  }

  return { groups: payloadGroups, pending, order };
}

// 保存成功：把服务端 id 回填到本地对象（就地改，绝不换对象），并刷新快照。
export function commitSavePayload(order, serverGroups, state) {
  order.forEach((entry, index) => {
    const server = (serverGroups || [])[index];
    if (!server) return;
    if (server.id) entry.group.id = server.id;
    (entry.sites || []).forEach((site, siteIndex) => {
      if (!site) return;
      const serverSite = (server.sites || [])[siteIndex];
      if (serverSite && serverSite.id) site.id = serverSite.id;
      // 只有「本地已填完整」才算新的可复用快照；占位提交的不能刷新快照。
      if (isCompleteSite(site)) state.snapshots.set(site, normalizeSiteForSave(site));
    });
    if (isCompleteGroup(entry.group)) {
      state.snapshots.set(entry.group, { name: trim(entry.group.name), description: trim(entry.group.description) });
    }
  });
}

// 给用户看的人话说明：本次有哪些东西没能入库 / 被占位保护了。
// 措辞要「可执行」——告诉用户为什么没入库、接下来做什么，而不是甩一个技术原因。
export function pendingSummary(pending) {
  const parts = [];
  if (pending.sites) parts.push(`${pending.sites} 个新入口还没填「名称 + 访问地址」，填好后会自动保存`);
  if (pending.groups) parts.push(`${pending.groups} 个分组还没命名，填好后会自动保存`);
  if (pending.preserved) parts.push(`${pending.preserved} 处改动还没填完整，服务器上保留的仍是上次保存的内容`);
  return parts.join('；');
}
