import { loadAppearance } from '../appearance.js';
import { setWorkspaceUser } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';

const editor = document.querySelector('#adminEditor');
const saveBtn = document.querySelector('#saveBtn');
const addGroupBtn = document.querySelector('#addGroupBtn');
const saveStatus = document.querySelector('#saveStatus');
const userName = document.querySelector('#userName');
const logoutBtn = document.querySelector('#logoutBtn');
const panelTriggers = [...document.querySelectorAll('[data-admin-panel]')];
const panels = [...document.querySelectorAll('.admin-panel')];
const userList = document.querySelector('#userList');
const userStatus = document.querySelector('#userStatus');
const adminSearch = document.querySelector('#admin-search');
const createUserForm = document.querySelector('#createUserForm');
const newUsername = document.querySelector('#newUsername');
const newNick = document.querySelector('#newNick');
const newPassword = document.querySelector('#newPassword');
const newRole = document.querySelector('#newRole');
const roleMatrix = document.querySelector('#roleMatrix');
const auditList = document.querySelector('#auditList');
const operationLogList = document.querySelector('#operationLogList');
const refreshAuditBtn = document.querySelector('#refreshAuditBtn');
const refreshLogsBtn = document.querySelector('#refreshLogsBtn');
const refreshMonitorBtn = document.querySelector('#refreshMonitorBtn');
const monitorGrid = document.querySelector('#monitorGrid');
const backupBtn = document.querySelector('#backupBtn');
const backupPreview = document.querySelector('#backupPreview');
const settingsForm = document.querySelector('#settingsForm');
const emailSettingsForm = document.querySelector('#emailSettingsForm');
const securitySettingsForm = document.querySelector('#securitySettingsForm');
const settingsStatus = document.querySelector('#settingsStatus');
const settingsStatusNodes = [
  settingsStatus,
  document.querySelector('#emailSettingsStatus'),
  document.querySelector('#securitySettingsStatus'),
  document.querySelector('#backupStatus')
].filter(Boolean);
const statTotalUsers = document.querySelector('#stat-total-users');
const statOnlineUsers = document.querySelector('#stat-online-users');
const statNewUsers = document.querySelector('#stat-new-users');
const statHealth = document.querySelector('#stat-health');

const settingFields = {
  productName: document.querySelector('#settingProductName'),
  companyName: document.querySelector('#settingCompanyName'),
  frontendUrl: document.querySelector('#settingFrontendUrl'),
  passwordMinLength: document.querySelector('#settingPasswordMinLength'),
  sessionHours: document.querySelector('#settingSessionHours'),
  ssoTicketTtlSeconds: document.querySelector('#settingSsoTicketTtlSeconds'),
  requireDingTalk: document.querySelector('#settingRequireDingTalk'),
  smtpEnabled: document.querySelector('#settingSmtpEnabled'),
  smtpHost: document.querySelector('#settingSmtpHost'),
  smtpPort: document.querySelector('#settingSmtpPort'),
  smtpFrom: document.querySelector('#settingSmtpFrom'),
  backupRetentionDays: document.querySelector('#settingBackupRetentionDays')
};

const actionLabels = {
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'user.reset_password': '重置密码',
  'sites.save': '保存站点',
  'settings.update': '更新配置',
  'backup.export': '导出快照'
};

let currentUser = null;
let groups = [];
let users = [];
let overview = {};
let settings = {};
let auditLogs = [];

logoutBtn.addEventListener('click', logout);
addGroupBtn.addEventListener('click', () => {
  groups.push({ name: '', description: '', sites: [] });
  renderGroups();
});
saveBtn.addEventListener('click', saveGroups);
createUserForm.addEventListener('submit', createUser);
adminSearch.addEventListener('input', renderUsers);
const roleFilter = document.querySelector('#memberRoleFilter');
const statusFilter = document.querySelector('#memberStatusFilter');
roleFilter.addEventListener('change', renderUsers);
statusFilter.addEventListener('change', renderUsers);
settingsForm.addEventListener('submit', saveSettings);
emailSettingsForm.addEventListener('submit', saveSettings);
securitySettingsForm.addEventListener('submit', saveSettings);
refreshAuditBtn.addEventListener('click', refreshAuditLogs);
refreshLogsBtn.addEventListener('click', refreshAuditLogs);
refreshMonitorBtn.addEventListener('click', refreshOverview);
backupBtn.addEventListener('click', createBackup);
settingFields.backupRetentionDays.addEventListener('change', () => saveSettingsFromCurrent('备份保留策略已保存。'));

panelTriggers.forEach((trigger) => {
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    showPanel(trigger.dataset.adminPanel, true);
  });
});

window.addEventListener('hashchange', () => showPanel(getInitialPanel()));
init();

async function init() {
  try {
    currentUser = await requireUser();
    if (!currentUser) {
      return;
    }
    if (currentUser.role !== 'admin') {
      redirectToLogin('当前账号没有后台权限。');
      return;
    }
    setWorkspaceUser(currentUser);
    void loadAppearance(currentUser);
    userName.textContent = currentUser.nick || currentUser.username || '汐航管理员';

    const [overviewPayload, groupPayload, userPayload, settingsPayload, logPayload] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/groups'),
      api('/api/admin/users'),
      api('/api/admin/settings'),
      api('/api/admin/audit-logs')
    ]);

    overview = overviewPayload.overview || {};
    groups = groupPayload.groups || [];
    users = userPayload.users || [];
    settings = settingsPayload.settings || overview.settings || {};
    auditLogs = logPayload.logs || [];

    renderGroups();
    renderUsers();
    renderStats();
    renderRoleMatrix();
    fillSettingsForm();
    renderMonitor();
    renderAuditLogs();
    showPanel(getInitialPanel());
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    editor.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
    userList.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
  }
}

function getInitialPanel() {
  const panel = window.location.hash.replace('#', '');
  return panels.some((node) => node.dataset.panel === panel) ? panel : 'users';
}

function showPanel(panel, navigate = false) {
  const activePanel = panels.find(node => node.dataset.panel === panel);
  if (!activePanel) return;
  panels.forEach(node => node.classList.toggle('hidden', node !== activePanel));
  panelTriggers.forEach(trigger => {
    const active = trigger.dataset.adminPanel === panel;
    trigger.classList.toggle('active', active);
    if (trigger.matches('a')) {
      if (active) trigger.setAttribute('aria-current', 'page');
      else trigger.removeAttribute('aria-current');
    } else trigger.setAttribute('aria-selected', String(active));
  });
  document.querySelector('#admin-title').textContent = activePanel.querySelector('h2').textContent;
  document.querySelector('.topbar-subtitle').textContent = activePanel.querySelector('.board-head p:last-child').textContent;
  document.querySelector('#admin-stats').classList.toggle('hidden', panel !== 'users');
  document.body.dataset.adminView = panel;
  if (navigate && window.location.hash !== `#${panel}`) window.location.hash = panel;
}

async function refreshOverview() {
  const payload = await api('/api/admin/overview');
  overview = payload.overview || {};
  settings = overview.settings || settings;
  renderStats();
  renderRoleMatrix();
  renderMonitor();
  fillSettingsForm();
}

async function refreshUsers() {
  const payload = await api('/api/admin/users');
  users = payload.users || [];
  renderUsers();
  renderStats();
  renderRoleMatrix();
}

async function refreshAuditLogs() {
  const payload = await api('/api/admin/audit-logs');
  auditLogs = payload.logs || [];
  renderAuditLogs();
}

async function createUser(event) {
  event.preventDefault();
  userStatus.textContent = '正在创建成员账号...';

  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: newUsername.value,
        nick: newNick.value,
        password: newPassword.value,
        role: newRole.value,
        status: 'active'
      })
    });
    createUserForm.reset();
    newRole.value = 'member';
    await Promise.all([refreshUsers(), refreshOverview(), refreshAuditLogs()]);
    userStatus.textContent = '成员已创建。首次登录会先进入改密页面。';
  } catch (error) {
    userStatus.textContent = error.message;
  }
}

function renderUsers() {
  const visibleUsers = getVisibleUsers();
  document.querySelector("#memberResultCount").textContent = `显示 ${visibleUsers.length} / ${users.length} 位成员`;

  if (users.length === 0) {
    userList.innerHTML = '<div class="empty-card">还没有成员账号。创建后会出现在这里。</div>';
    return;
  }

  if (visibleUsers.length === 0) {
    userList.innerHTML = '<div class="empty-card">没有匹配的成员账号。</div>';
    return;
  }

  userList.innerHTML = visibleUsers.map(renderUserRow).join('');
  userList.querySelectorAll('[data-action="save-user"]').forEach((button) => {
    button.addEventListener('click', () => saveUser(Number(button.dataset.id)));
  });
  userList.querySelectorAll('[data-action="reset-password"]').forEach((button) => {
    button.addEventListener('click', () => resetPassword(Number(button.dataset.id)));
  });
  userList.querySelectorAll('[data-action="delete-user"]').forEach((button) => {
    button.addEventListener('click', () => deleteSelectedUser(Number(button.dataset.id)));
  });
}

function getVisibleUsers() {
  const query = adminSearch.value.trim().toLowerCase();
  return users.filter(user => (!roleFilter.value || user.role === roleFilter.value) &&
    (!statusFilter.value || user.status === statusFilter.value) &&
    [user.username, user.nick, user.role, user.status, user.authType].join(' ').toLowerCase().includes(query));
}

function renderStats() {
  statTotalUsers.textContent = String(overview.totalUsers ?? users.length);
  statOnlineUsers.textContent = String(overview.onlineUsers ?? 0);
  statNewUsers.textContent = String(overview.newUsersToday ?? 0);
  statHealth.textContent = String(overview.health ?? 100);
}

function renderRoleMatrix() {
  const adminCount = Number(overview.adminUsers ?? users.filter((user) => user.role === 'admin').length);
  const memberCount = Number(overview.memberUsers ?? users.filter((user) => user.role !== 'admin').length);
  const roles = [
    {
      title: '管理员',
      count: adminCount,
      badge: 'Admin',
      permissions: ['维护用户与状态', '创建站点入口', '修改系统配置', '查看审计与备份']
    },
    {
      title: '普通成员',
      count: memberCount,
      badge: 'Member',
      permissions: ['访问工作台入口', '维护个人星钥库', '查看本人凭证', '首次登录强制改密']
    }
  ];

  roleMatrix.innerHTML = roles
    .map(
      (role) => `<article class="role-card">
  <div>
    <span>${role.badge}</span>
    <strong>${role.title}</strong>
    <small>${role.count} 个账号</small>
  </div>
  <ul>${role.permissions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
</article>`
    )
    .join('');
}

function renderUserRow(user) {
  const isSelf = currentUser?.id === user.id;
  const roleOptions = [option('member', '普通成员', user.role), option('admin', '管理员', user.role)].join('');
  const statusOptions = [option('active', '启用', user.status), option('disabled', '禁用', user.status)].join('');

  return `<article class="user-row" data-user-id="${user.id}">
  <div class="user-main">
    <strong>${escapeHtml(user.nick || user.username)}</strong>
    <span>${escapeHtml(user.username)} · ${user.authType === 'dingtalk' ? '钉钉身份' : '本地账号'}</span>
  </div>
  <input class="field-input compact-input" data-field="nick" value="${escapeHtml(user.nick || '')}" placeholder="姓名/昵称" />
  <select class="field-input compact-input" data-field="role" ${isSelf ? 'disabled' : ''}>${roleOptions}</select>
  <select class="field-input compact-input" data-field="status" ${isSelf ? 'disabled' : ''}>${statusOptions}</select>
  <div class="user-flags">
    <span>${user.mustChangePassword ? '等待首次改密' : '密码已就绪'}</span>
    <span>星钥库 ${user.vaultCount || 0} 条</span>
  </div>
  <div class="row-actions">
    <button class="plain-btn small" type="button" data-action="save-user" data-id="${user.id}">保存</button>
    <button class="plain-btn small" type="button" data-action="reset-password" data-id="${user.id}">重置</button>
    <button class="danger-btn small" type="button" data-action="delete-user" data-id="${user.id}" ${isSelf ? 'disabled' : ''}>删除</button>
  </div>
</article>`;
}

async function saveUser(userId) {
  const row = userList.querySelector(`[data-user-id="${userId}"]`);
  const body = {
    nick: row.querySelector('[data-field="nick"]').value,
    role: row.querySelector('[data-field="role"]').value,
    status: row.querySelector('[data-field="status"]').value
  };
  userStatus.textContent = '正在保存成员信息...';

  try {
    await api(`/api/admin/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    await Promise.all([refreshUsers(), refreshOverview(), refreshAuditLogs()]);
    userStatus.textContent = '成员信息已保存。';
  } catch (error) {
    userStatus.textContent = error.message;
  }
}

async function resetPassword(userId) {
  const password = window.prompt('请输入新的临时密码，至少 8 位。成员下次登录必须先修改。');
  if (!password) {
    return;
  }
  userStatus.textContent = '正在重置临时密码...';

  try {
    await api(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    await Promise.all([refreshUsers(), refreshAuditLogs()]);
    userStatus.textContent = '临时密码已重置。该成员下次登录会先进入改密页面。';
  } catch (error) {
    userStatus.textContent = error.message;
  }
}

async function deleteSelectedUser(userId) {
  const user = users.find((item) => item.id === userId);
  if (!user || !window.confirm(`确认删除用户 ${user.nick || user.username}？该用户的个人星钥库记录也会同步删除。`)) {
    return;
  }

  userStatus.textContent = '正在删除成员账号...';
  try {
    await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
    await Promise.all([refreshUsers(), refreshOverview(), refreshAuditLogs()]);
    userStatus.textContent = '成员账号已删除。';
  } catch (error) {
    userStatus.textContent = error.message;
  }
}

function renderGroups() {
  editor.innerHTML = '';

  if (groups.length === 0) {
    editor.appendChild(el('div', 'empty-card', '站点矩阵还没有分组。点击“新增分组”，先搭一个入口分组。'));
    return;
  }

  groups.forEach((group, groupIndex) => {
    const groupCard = el('section', 'admin-card');
    const groupTop = el('div', 'admin-card-top');
    const title = el('strong', '', `入口分组 ${groupIndex + 1}`);
    const actions = el('div', 'row-actions');
    const addSiteBtn = el('button', 'plain-btn small', '新增入口');
    const removeGroupBtn = el('button', 'danger-btn small', '删除分组');

    addSiteBtn.type = 'button';
    removeGroupBtn.type = 'button';
    addSiteBtn.addEventListener('click', () => {
      group.sites = group.sites || [];
      group.sites.push({ name: '', url: '', description: '', tags: [], visibility: 'all', allowedRoles: [], allowedUserIds: [] });
      renderGroups();
    });
    removeGroupBtn.addEventListener('click', () => {
      groups.splice(groupIndex, 1);
      renderGroups();
    });

    actions.append(addSiteBtn, removeGroupBtn);
    groupTop.append(title, actions);
    groupCard.appendChild(groupTop);
    groupCard.appendChild(field('分组名称', input(group.name, '例如：产品与业务', (value) => (group.name = value))));
    groupCard.appendChild(field('分组说明', textarea(group.description, '说明这里放哪些内部入口', (value) => (group.description = value))));

    const sites = el('div', 'site-editor-list');
    (group.sites || []).forEach((site, siteIndex) => {
      const siteCard = el('details', 'site-editor');
      siteCard.open = !site.name;
      const siteTop = el('summary', 'admin-card-top');
      const siteTitle = el('strong', '', site.name || `新入口 ${siteIndex + 1}`);
      const removeSiteBtn = el('button', 'danger-btn small', '删除入口');
      removeSiteBtn.type = 'button';
      removeSiteBtn.addEventListener('click', (event) => {
        event.preventDefault();
        group.sites.splice(siteIndex, 1);
        renderGroups();
      });

      siteTop.append(siteTitle, removeSiteBtn);
      siteCard.appendChild(siteTop);
      siteCard.appendChild(field('入口名称', input(site.name, '例如：运营后台', (value) => (site.name = value))));
      siteCard.appendChild(field('访问地址', input(site.url, 'https://...', (value) => (site.url = value))));
      siteCard.appendChild(field('入口说明', textarea(site.description, '一句话说明用途', (value) => (site.description = value))));
      siteCard.appendChild(
        field(
          '标签',
          input((site.tags || []).join(', '), '多个标签用逗号分隔', (value) => {
            site.tags = value
              .split(/[,，]/)
              .map((tag) => tag.trim())
              .filter(Boolean);
          })
        )
      );
      siteCard.appendChild(renderSiteAccessEditor(site));
      sites.appendChild(siteCard);
    });

    groupCard.appendChild(sites);
    editor.appendChild(groupCard);
  });
}

async function saveGroups() {
  saveBtn.disabled = true;
  saveStatus.textContent = '正在保存...';

  try {
    const payload = await api('/api/admin/groups', {
      method: 'PUT',
      body: JSON.stringify({ groups })
    });
    groups = payload.groups;
    renderGroups();
    await Promise.all([refreshOverview(), refreshAuditLogs()]);
    saveStatus.textContent = '已保存到 MySQL，成员刷新工作台即可看到新的入口分组。';
  } catch (error) {
    saveStatus.textContent = error.message;
  } finally {
    saveBtn.disabled = false;
  }
}

function renderSiteAccessEditor(site) {
  site.visibility = normalizeSiteVisibility(site.visibility);
  site.allowedRoles = normalizeSiteRoles(site.allowedRoles);
  site.allowedUserIds = normalizeSiteUserIds(site.allowedUserIds);

  const wrapper = el('div', 'site-access-panel');
  const top = el('div', 'site-access-top');
  const title = el('div', 'site-access-title');
  title.append(el('strong', '', '可见范围'), el('span', '', '控制这个入口在工作台里对哪些成员展示'));

  const visibilitySelect = el('select', 'field-input compact-input');
  visibilitySelect.innerHTML = [
    option('all', '所有成员', site.visibility),
    option('admins', '仅管理员', site.visibility),
    option('roles', '按角色', site.visibility),
    option('users', '指定成员', site.visibility)
  ].join('');
  visibilitySelect.addEventListener('change', () => {
    site.visibility = visibilitySelect.value;
    if (site.visibility === 'roles' && site.allowedRoles.length === 0) {
      site.allowedRoles = ['member'];
    }
    renderGroups();
  });

  top.append(title, visibilitySelect);
  wrapper.appendChild(top);

  if (site.visibility === 'roles') {
    const roleList = el('div', 'site-access-checks');
    [
      ['member', '普通成员'],
      ['admin', '管理员']
    ].forEach(([value, label]) => {
      const checkboxLabel = el('label', 'access-check');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = site.allowedRoles.includes(value);
      checkbox.addEventListener('change', () => {
        site.allowedRoles = toggleListValue(site.allowedRoles, value, checkbox.checked);
      });
      checkboxLabel.append(checkbox, el('span', '', label));
      roleList.appendChild(checkboxLabel);
    });
    wrapper.appendChild(roleList);
  }

  if (site.visibility === 'users') {
    const memberList = el('div', 'site-member-grid');
    const selectableUsers = users.filter((user) => user.status !== 'disabled');

    if (selectableUsers.length === 0) {
      memberList.appendChild(el('span', 'site-access-empty', '暂无可分配成员'));
    }

    selectableUsers.forEach((user) => {
      const userId = Number(user.id);
      const checkboxLabel = el('label', 'access-check member-check');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = site.allowedUserIds.includes(userId);
      checkbox.addEventListener('change', () => {
        site.allowedUserIds = toggleListValue(site.allowedUserIds, userId, checkbox.checked);
      });
      checkboxLabel.append(checkbox, el('span', '', userDisplayName(user)));
      memberList.appendChild(checkboxLabel);
    });
    wrapper.appendChild(memberList);
  }

  return wrapper;
}

function fillSettingsForm() {
  Object.entries(settingFields).forEach(([key, inputNode]) => {
    if (!inputNode) {
      return;
    }
    if (inputNode.type === 'checkbox') {
      inputNode.checked = settings[key] === true || settings[key] === 'true';
      return;
    }
    inputNode.value = settings[key] ?? '';
  });
}

function readSettingsFromForm() {
  const nextSettings = {};
  Object.entries(settingFields).forEach(([key, inputNode]) => {
    nextSettings[key] = inputNode.type === 'checkbox' ? inputNode.checked : inputNode.value;
  });
  return nextSettings;
}

async function saveSettings(event) {
  event.preventDefault();
  await saveSettingsFromCurrent('配置已保存。');
}

async function saveSettingsFromCurrent(successText) {
  setSettingsStatus('正在保存配置...');
  try {
    const payload = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: readSettingsFromForm() })
    });
    settings = payload.settings || settings;
    fillSettingsForm();
    await Promise.all([refreshOverview(), refreshAuditLogs()]);
    setSettingsStatus(successText);
  } catch (error) {
    setSettingsStatus(error.message);
  }
}

function setSettingsStatus(text) {
  settingsStatusNodes.forEach((node) => {
    node.textContent = text;
  });
}

function renderMonitor() {
  const items = [
    ['总用户', overview.totalUsers ?? users.length, '系统内账号总量'],
    ['启用账号', overview.activeUsers ?? 0, '当前可登录账号'],
    ['禁用账号', overview.disabledUsers ?? 0, '已停用账号'],
    ['在线用户', overview.onlineUsers ?? 0, '15 分钟内有登录记录'],
    ['站点分组', overview.groupCount ?? groups.length, '工作台入口分组'],
    ['站点入口', overview.siteCount ?? countSites(groups), '可跳转系统入口'],
    ['星钥记录', overview.credentialCount ?? 0, '全站个人凭证记录数'],
    ['有效票据', overview.activeSsoTickets ?? 0, '未消费且未过期 SSO 票据'],
    ['今日审计', overview.todayAuditLogs ?? 0, '今日后台操作日志'],
    ['健康度', `${overview.health ?? 100}%`, '数据库和核心接口正常']
  ];

  monitorGrid.innerHTML = items
    .map(
      ([label, value, desc]) => `<article class="monitor-card">
  <span>${escapeHtml(label)}</span>
  <strong>${escapeHtml(value)}</strong>
  <small>${escapeHtml(desc)}</small>
</article>`
    )
    .join('');
}

function renderAuditLogs() {
  const html =
    auditLogs.length === 0
      ? '<div class="empty-card">还没有审计日志。保存配置或创建用户后会自动产生记录。</div>'
      : auditLogs.map(renderAuditRow).join('');

  auditList.innerHTML = html;
  operationLogList.innerHTML = html;
}

function renderAuditRow(log) {
  return `<article class="audit-row">
  <div>
    <strong>${escapeHtml(actionLabels[log.action] || log.action)}</strong>
    <span>${escapeHtml(log.summary || '-')}</span>
  </div>
  <div>
    <span>${escapeHtml(log.actorName || '系统')}</span>
    <small>${escapeHtml(log.ip || '-')}</small>
  </div>
  <time>${formatDate(log.createdAt)}</time>
</article>`;
}

async function createBackup() {
  backupPreview.textContent = '正在生成配置快照...';
  try {
    await saveSettingsFromCurrent('备份策略已保存。');
    const payload = await api('/api/admin/backup');
    backupPreview.textContent = JSON.stringify(payload.snapshot, null, 2);
    await refreshAuditLogs();
  } catch (error) {
    backupPreview.textContent = error.message;
  }
}

function countSites(siteGroups) {
  return siteGroups.reduce((total, group) => total + (group.sites || []).length, 0);
}

function normalizeSiteVisibility(value) {
  return ['all', 'admins', 'roles', 'users'].includes(value) ? value : 'all';
}

function normalizeSiteRoles(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : String(value || '').split(/[,，]/))
        .map((item) => String(item || '').trim())
        .filter((item) => item === 'admin' || item === 'member')
    )
  ];
}

function normalizeSiteUserIds(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : String(value || '').split(/[,，]/))
        .map((item) => Number(item))
        .filter((item) => Number.isSafeInteger(item) && item > 0)
    )
  ];
}

function toggleListValue(list, value, enabled) {
  const next = new Set(list || []);
  if (enabled) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return [...next];
}

function userDisplayName(user) {
  return `${user.nick || user.username} (${user.username})`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function input(value, placeholder, onInput) {
  const node = el('input', 'field-input');
  node.value = value || '';
  node.placeholder = placeholder;
  node.addEventListener('input', () => onInput(node.value));
  return node;
}

function textarea(value, placeholder, onInput) {
  const node = el('textarea', 'field-input');
  node.value = value || '';
  node.placeholder = placeholder;
  node.rows = 2;
  node.addEventListener('input', () => onInput(node.value));
  return node;
}

function field(label, control) {
  const wrapper = el('label', 'field');
  wrapper.append(el('span', '', label), control);
  return wrapper;
}

function option(value, label, selectedValue) {
  return `<option value="${value}" ${value === selectedValue ? 'selected' : ''}>${label}</option>`;
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

