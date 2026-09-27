import { setWorkspaceUser, syncActiveHeading, setNotifications } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';
import { showToast, closeDialogAnimated } from '../ui-feedback.js';

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
const automationSettingsForm = document.querySelector('#automationSettingsForm');
const settingsStatus = document.querySelector('#settingsStatus');
const settingsStatusNodes = [
  settingsStatus,
  document.querySelector('#emailSettingsStatus'),
  document.querySelector('#securitySettingsStatus'),
  document.querySelector('#automationSettingsStatus'),
  document.querySelector('#rosterSettingsStatus'),
  document.querySelector('#backupStatus')
].filter(Boolean);
const addProjectBtn = document.querySelector('#addProjectBtn');
const projectRows = document.querySelector('#projectRows');
const projectListStatus = document.querySelector('#projectListStatus');
const projectDialog = document.querySelector('#projectEditDialog');
const projectForm = document.querySelector('#projectForm');
const projectFormStatus = document.querySelector('#projectFormStatus');
const projectCancelBtn = document.querySelector('#projectCancelBtn');
const projectSaveBtn = document.querySelector('#projectSaveBtn');
const projectFields = ['name', 'status', 'priority', 'lastUpdate', 'nextMilestone', 'nextMilestoneDate', 'ownerPhone', 'note'];
const siteScopeDialog = document.querySelector('#siteScopeDialog');
const siteScopeHint = document.querySelector('#siteScopeDialogHint');
const siteScopeRolesBox = document.querySelector('#siteScopeRoles');
const siteScopeUsersBox = document.querySelector('#siteScopeUsers');
const siteScopeCancelBtn = document.querySelector('#siteScopeCancelBtn');
const siteScopeSaveBtn = document.querySelector('#siteScopeSaveBtn');
// The scope dialog edits a draft, not `site` directly — otherwise every
// checkbox click would already be "saved" in memory and Cancel/Escape would
// do nothing (the next unrelated autosave would silently persist it anyway).
let scopeDialogSite = null;
let scopeDialogPreviousVisibility = null;
let scopeDialogDraftRoles = [];
let scopeDialogDraftUserIds = [];
const rosterSettingsForm = document.querySelector('#rosterSettingsForm');
const rosterSettingsStatus = document.querySelector('#rosterSettingsStatus');
const rosterSyncBtn = document.querySelector('#rosterSyncBtn');
const rosterSyncStatus = document.querySelector('#rosterSyncStatus');
const wikiSyncBtn = document.querySelector('#wikiSyncBtn');
const wikiSyncStatus = document.querySelector('#wikiSyncStatus');
const wikiDocListBody = document.querySelector('#wikiDocListBody');
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
  backupRetentionDays: document.querySelector('#settingBackupRetentionDays'),
  smsProvider: document.querySelector('#settingSmsProvider'),
  smsAccessKeyId: document.querySelector('#settingSmsAccessKeyId'),
  smsAccessKeySecret: document.querySelector('#settingSmsAccessKeySecret'),
  smsSignName: document.querySelector('#settingSmsSignName'),
  smsTemplateCode: document.querySelector('#settingSmsTemplateCode'),
  dingtalkNotifyAppKey: document.querySelector('#settingDingtalkNotifyAppKey'),
  dingtalkNotifyAppSecret: document.querySelector('#settingDingtalkNotifyAppSecret'),
  dingtalkNotifyAgentId: document.querySelector('#settingDingtalkNotifyAgentId'),
  dingtalkNotifyUserIds: document.querySelector('#settingDingtalkNotifyUserIds'),
  dingtalkNotifyDeptIds: document.querySelector('#settingDingtalkNotifyDeptIds'),
  dingtalkRosterAppKey: document.querySelector('#settingDingtalkRosterAppKey'),
  dingtalkRosterAppSecret: document.querySelector('#settingDingtalkRosterAppSecret'),
  dingtalkRosterCorpId: document.querySelector('#settingDingtalkRosterCorpId'),
  dingtalkWikiOperatorId: document.querySelector('#settingDingtalkWikiOperatorId')
};
// Secret fields: the backend never returns the real value, only a "configured" marker.
// The password input stays blank (so a blank submit means "leave it alone") and shows
// the marker as a placeholder hint instead of a value.
const SECRET_SETTING_KEYS = new Set(['smsAccessKeySecret', 'dingtalkNotifyAppSecret', 'dingtalkRosterAppSecret']);
const SECRET_CONFIGURED_MARKER = '__configured__';

const actionLabels = {
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'user.reset_password': '重置密码',
  'sites.save': '保存站点',
  'settings.update': '更新配置',
  'backup.export': '导出快照',
  'project.create': '创建项目',
  'project.update': '更新项目',
  'project.delete': '删除项目',
  'dingtalk.roster_sync': '同步钉钉花名册',
  'dingtalk.wiki_sync': '同步钉钉知识库'
};

let currentUser = null;
let groups = [];
let users = [];
let overview = {};
let settings = {};
let auditLogs = [];
let projects = [];
let editingProject = null;
let autoSaveTimer = null;
let sitesLoaded = false;

logoutBtn.addEventListener('click', logout);
addGroupBtn.addEventListener('click', () => {
  groups.push({ name: '', description: '', sites: [] });
  renderGroups();
  scheduleAutoSave();
});
saveBtn.addEventListener('click', () => saveGroups(false));
function discardSiteScopeDialog() {
  // Undo the dropdown's optimistic switch to "roles"/"users" if the user
  // backs out without confirming — otherwise the site is left stuck in that
  // mode (usually with an empty selection, i.e. visible to nobody) even
  // though nothing was actually configured.
  if (scopeDialogSite && scopeDialogSite.visibility !== scopeDialogPreviousVisibility) {
    scopeDialogSite.visibility = scopeDialogPreviousVisibility;
    renderGroups();
  }
  scopeDialogSite = null;
  closeDialogAnimated(siteScopeDialog);
}
siteScopeCancelBtn.addEventListener('click', discardSiteScopeDialog);
siteScopeSaveBtn.addEventListener('click', () => {
  if (scopeDialogSite) {
    scopeDialogSite.allowedRoles = scopeDialogDraftRoles;
    scopeDialogSite.allowedUserIds = scopeDialogDraftUserIds;
  }
  scopeDialogSite = null;
  closeDialogAnimated(siteScopeDialog);
  renderGroups();
  scheduleAutoSave();
  showToast('可见范围已更新', siteScopeSaveBtn);
});
siteScopeDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  discardSiteScopeDialog();
});
addProjectBtn.addEventListener('click', () => openProjectEditor(null));
projectCancelBtn.addEventListener('click', () => { if (!projectForm.dataset.saving) closeDialogAnimated(projectDialog); });
projectDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!projectForm.dataset.saving) closeDialogAnimated(projectDialog);
});
projectForm.addEventListener('submit', saveProject);
createUserForm.addEventListener('submit', createUser);
adminSearch.addEventListener('input', renderUsers);
const roleFilter = document.querySelector('#memberRoleFilter');
const statusFilter = document.querySelector('#memberStatusFilter');
roleFilter.addEventListener('change', renderUsers);
statusFilter.addEventListener('change', renderUsers);
settingsForm.addEventListener('submit', saveSettings);
emailSettingsForm.addEventListener('submit', saveSettings);
securitySettingsForm.addEventListener('submit', saveSettings);
automationSettingsForm.addEventListener('submit', saveSettings);
rosterSettingsForm.addEventListener('submit', saveSettings);
rosterSyncBtn.addEventListener('click', syncDingTalkRoster);
wikiSyncBtn.addEventListener('click', syncDingTalkWiki);
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

initNavGroups();
function initNavGroups() {
  const collapsedKey = 'tidesail.admin.navGroups.collapsed';
  let collapsed;
  try { collapsed = new Set(JSON.parse(localStorage.getItem(collapsedKey) || '[]')); } catch { collapsed = new Set(); }
  const save = () => { try { localStorage.setItem(collapsedKey, JSON.stringify([...collapsed])); } catch {} };
  document.querySelectorAll('.nav-group').forEach((group) => {
    const toggle = group.querySelector('.nav-group-title');
    const items = group.querySelector('.nav-group-items');
    if (!toggle || !items) return;
    if (!items.id) items.id = `${toggle.id}-items`;
    toggle.setAttribute('aria-controls', items.id);
    const applyState = () => {
      const isCollapsed = collapsed.has(toggle.id);
      group.classList.toggle('collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
    };
    applyState();
    toggle.addEventListener('click', () => {
      if (collapsed.has(toggle.id)) collapsed.delete(toggle.id); else collapsed.add(toggle.id);
      save();
      applyState();
    });
  });
}

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
    userName.textContent = currentUser.nick || currentUser.username || '汐航管理员';

    const [overviewPayload, groupPayload, userPayload, settingsPayload, logPayload, projectPayload] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/groups'),
      api('/api/admin/users'),
      api('/api/admin/settings'),
      api('/api/admin/audit-logs'),
      api('/api/admin/projects')
    ]);

    overview = overviewPayload.overview || {};
    groups = groupPayload.groups || [];
    users = userPayload.users || [];
    settings = settingsPayload.settings || overview.settings || {};
    auditLogs = logPayload.logs || [];
    projects = projectPayload.projects || [];

    renderGroups();
    sitesLoaded = true;
    renderUsers();
    renderStats();
    renderRoleMatrix();
    fillSettingsForm();
    renderMonitor();
    renderAuditLogs();
    renderProjects();
    loadWikiDocs();
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
  syncActiveHeading();
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
    showToast('成员已创建', createUserForm.querySelector('.primary-btn'));
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
    showToast('已保存', row);
  } catch (error) {
    userStatus.textContent = error.message;
  }
}

async function resetPassword(userId) {
  const password = window.prompt('请输入新的临时密码，至少 8 位。成员下次登录必须先修改。');
  if (!password) {
    return;
  }
  const row = userList.querySelector(`[data-user-id="${userId}"]`);
  userStatus.textContent = '正在重置临时密码...';

  try {
    await api(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    await Promise.all([refreshUsers(), refreshAuditLogs()]);
    userStatus.textContent = '临时密码已重置。该成员下次登录会先进入改密页面。';
    showToast('临时密码已重置', row);
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
    showToast('成员账号已删除', userStatus);
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
      scheduleAutoSave();
    });
    removeGroupBtn.addEventListener('click', () => {
      groups.splice(groupIndex, 1);
      renderGroups();
      scheduleAutoSave();
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
        scheduleAutoSave();
      });

      siteTop.append(siteTitle, removeSiteBtn);
      siteCard.appendChild(siteTop);
      if (!site.name || !site.url) {
        // Matches the backend's own filter (normalizeSiteGroups drops any
        // site missing name/url) — surfaced here so an incomplete entry
        // doesn't just silently fail to persist without explanation.
        siteCard.appendChild(el('p', 'hint', '还没保存：填写入口名称和访问地址后才会存到 MySQL。'));
      }
      siteCard.appendChild(field('入口名称', input(site.name, '例如：运营后台', (value) => (site.name = value))));
      siteCard.appendChild(field('访问地址', input(site.url, 'https://...', (value) => (site.url = value))));
      siteCard.appendChild(
        field(
          '图标地址（可选）',
          input(site.iconUrl || '', 'https://.../favicon.png', (value) => {
            site.iconUrl = value.trim();
          })
        )
      );
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

function scheduleAutoSave() {
  if (!sitesLoaded) return;
  clearTimeout(autoSaveTimer);
  saveStatus.textContent = '有修改，准备自动保存…';
  autoSaveTimer = setTimeout(() => saveGroups(true), 900);
}

async function saveGroups(isAuto = false) {
  clearTimeout(autoSaveTimer);
  saveBtn.disabled = true;
  saveStatus.textContent = isAuto ? '正在自动保存...' : '正在保存...';

  try {
    const payload = await api('/api/admin/groups', {
      method: 'PUT',
      body: JSON.stringify({ groups })
    });
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    groups = payload.groups;

    if (isAuto) {
      // Autosave must never rebuild the editor DOM: renderGroups() replaces
      // every <input>/<textarea> in the panel, which — if the user is mid
      // keystroke when the debounce fires, a completely normal timing —
      // silently rips focus out of whatever field they're typing in. We
      // still refresh `groups` in the background so a later manual save or
      // structural edit starts from the server's canonical copy, but we
      // leave the visible DOM (and the user's cursor) untouched.
      saveStatus.textContent = `已自动保存到 MySQL（${time}）`;
    } else {
      renderGroups();
      saveStatus.textContent = `已保存到 MySQL（${time}），成员刷新工作台即可看到新的入口分组。`;
      showToast('已保存', saveStatus);
    }

    await Promise.all([refreshOverview(), refreshAuditLogs()]);
  } catch (error) {
    saveStatus.textContent = `${isAuto ? '自动保存' : '保存'}失败：${error.message}`;
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
    const previousVisibility = site.visibility;
    site.visibility = visibilitySelect.value;
    if (site.visibility === 'roles' && site.allowedRoles.length === 0) {
      site.allowedRoles = ['member'];
    }
    renderGroups();
    if (site.visibility === 'roles' || site.visibility === 'users') {
      // Don't autosave yet — the scope dialog opens next, and cancelling it
      // should be able to fully back out of this switch (see discardSiteScopeDialog).
      openSiteScopeDialog(site, previousVisibility);
    } else {
      scheduleAutoSave();
    }
  });

  top.append(title, visibilitySelect);
  wrapper.appendChild(top);

  if (site.visibility === 'roles' || site.visibility === 'users') {
    const summary = el('div', 'site-access-summary');
    const summaryText =
      site.visibility === 'roles'
        ? `已选 ${site.allowedRoles.length} 个角色`
        : `已选 ${site.allowedUserIds.length} 位成员`;
    summary.appendChild(el('span', '', summaryText));
    const editBtn = el('button', 'plain-btn small', '配置可见范围');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openSiteScopeDialog(site));
    summary.appendChild(editBtn);
    wrapper.appendChild(summary);
  }

  return wrapper;
}

function openSiteScopeDialog(site, previousVisibility = site.visibility) {
  scopeDialogSite = site;
  scopeDialogPreviousVisibility = previousVisibility;
  scopeDialogDraftRoles = [...site.allowedRoles];
  scopeDialogDraftUserIds = [...site.allowedUserIds];
  siteScopeRolesBox.innerHTML = '';
  siteScopeUsersBox.innerHTML = '';

  if (site.visibility === 'roles') {
    siteScopeHint.textContent = '选择哪些角色能在工作台里看到这个入口。';
    siteScopeRolesBox.hidden = false;
    siteScopeUsersBox.hidden = true;
    [
      ['member', '普通成员'],
      ['admin', '管理员']
    ].forEach(([value, label]) => {
      const checkboxLabel = el('label', 'access-check');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = scopeDialogDraftRoles.includes(value);
      checkbox.addEventListener('change', () => {
        scopeDialogDraftRoles = toggleListValue(scopeDialogDraftRoles, value, checkbox.checked);
      });
      checkboxLabel.append(checkbox, el('span', '', label));
      siteScopeRolesBox.appendChild(checkboxLabel);
    });
  } else if (site.visibility === 'users') {
    siteScopeHint.textContent = '选择哪些成员能在工作台里看到这个入口。';
    siteScopeRolesBox.hidden = true;
    siteScopeUsersBox.hidden = false;
    const selectableUsers = users.filter((user) => user.status !== 'disabled');

    if (selectableUsers.length === 0) {
      siteScopeUsersBox.appendChild(el('span', 'site-access-empty', '暂无可分配成员'));
    }

    selectableUsers.forEach((user) => {
      const userId = Number(user.id);
      const checkboxLabel = el('label', 'access-check member-check');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = scopeDialogDraftUserIds.includes(userId);
      checkbox.addEventListener('change', () => {
        scopeDialogDraftUserIds = toggleListValue(scopeDialogDraftUserIds, userId, checkbox.checked);
      });
      checkboxLabel.append(checkbox, el('span', '', userDisplayName(user)));
      siteScopeUsersBox.appendChild(checkboxLabel);
    });
  }

  siteScopeDialog.showModal();
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
    if (SECRET_SETTING_KEYS.has(key)) {
      inputNode.value = '';
      inputNode.placeholder = settings[key] === SECRET_CONFIGURED_MARKER ? '已配置，留空则不修改' : '未配置';
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
  await saveSettingsFromCurrent('配置已保存。', event.submitter);
}

async function saveSettingsFromCurrent(successText, trigger) {
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
    showToast(successText, trigger || settingsStatus);
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
  setNotifications(auditLogs.map(log => ({ title: `${actionLabels[log.action] || log.action}${log.summary ? ' · ' + log.summary : ''}`, time: formatDate(log.createdAt) })));
  renderRosterStatus();
}

function renderRosterStatus() {
  const lastSync = auditLogs.find((log) => log.action === 'dingtalk.roster_sync');
  rosterSyncStatus.textContent = lastSync
    ? `上次同步：${formatDate(lastSync.createdAt)} · ${lastSync.summary || ''}`
    : '还没有同步过。';
}

async function syncDingTalkRoster() {
  rosterSyncBtn.disabled = true;
  rosterSyncStatus.textContent = '正在同步钉钉花名册...';

  try {
    const payload = await api('/api/admin/dingtalk/roster-sync', { method: 'POST' });
    const { total, created, updated, disabled } = payload.stats;
    rosterSyncStatus.textContent = `同步完成：花名册共 ${total} 人，新建 ${created}，刷新 ${updated}，禁用 ${disabled}。`;
    await Promise.all([refreshUsers(), refreshAuditLogs()]);
  } catch (error) {
    rosterSyncStatus.textContent = `同步失败：${error.message}`;
  } finally {
    rosterSyncBtn.disabled = false;
  }
}

async function syncDingTalkWiki() {
  wikiSyncBtn.disabled = true;
  wikiSyncStatus.textContent = '正在同步钉钉知识库...';

  try {
    const payload = await api('/api/admin/dingtalk/wiki-sync', { method: 'POST' });
    const { workspaces, docs } = payload.stats;
    wikiSyncStatus.textContent = `同步完成：${workspaces} 个知识库，${docs} 篇文档。`;
    await Promise.all([loadWikiDocs(), refreshAuditLogs()]);
  } catch (error) {
    wikiSyncStatus.textContent = `同步失败：${error.message}`;
  } finally {
    wikiSyncBtn.disabled = false;
  }
}

async function loadWikiDocs() {
  try {
    const payload = await api('/api/knowledge-base');
    renderWikiDocs(payload.docs || []);
  } catch (error) {
    // Knowledge-base list is secondary content on this panel; a failed
    // refresh shouldn't block the rest of the admin console from loading.
    // But silently leaving the container empty made a real fetch failure
    // look identical to "nothing synced yet" — show the error instead.
    wikiDocListBody.innerHTML = `<div class="empty-card">知识库列表加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderWikiDocs(docs) {
  if (docs.length === 0) {
    wikiDocListBody.innerHTML = '<div class="empty-card">还没有同步过知识库文档。</div>';
    return;
  }

  wikiDocListBody.innerHTML = docs
    .map(
      (doc) => `<article class="audit-row">
  <div>
    <strong>${escapeHtml(doc.name || '未命名文档')}</strong>
    <span>${escapeHtml(doc.workspaceName || '')}</span>
  </div>
  <div>
    <a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener noreferrer">在钉钉中打开</a>
    <small>${escapeHtml(formatDate(doc.modifiedTime))}</small>
  </div>
</article>`
    )
    .join('');
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
    showToast('配置快照已生成', backupBtn);
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
  node.addEventListener('input', () => {
    onInput(node.value);
    scheduleAutoSave();
  });
  return node;
}

function textarea(value, placeholder, onInput) {
  const node = el('textarea', 'field-input');
  node.value = value || '';
  node.placeholder = placeholder;
  node.rows = 2;
  node.addEventListener('input', () => {
    onInput(node.value);
    scheduleAutoSave();
  });
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

const PROJECT_STATUS_LABELS = { active: '进行中', paused: '已暂停', archived: '已归档' };

function renderProjects() {
  if (projects.length === 0) {
    projectRows.innerHTML = '<tr><td colspan="6" class="empty-card">还没有项目。新增后会出现在这里，成本台账、数据大屏和监督agent都会用到这份数据。</td></tr>';
    return;
  }
  projectRows.innerHTML = projects.map((project) => `<tr data-project-id="${project.id}">
  <td>${escapeHtml(project.name)}</td>
  <td>${escapeHtml(PROJECT_STATUS_LABELS[project.status] || project.status)}</td>
  <td>${escapeHtml(project.priority)}</td>
  <td>${escapeHtml(project.lastUpdate || '—')}</td>
  <td>${escapeHtml(project.nextMilestone || '—')}</td>
  <td class="row-actions">
    <button class="plain-btn small" type="button" data-action="edit-project" data-id="${project.id}">编辑</button>
    <button class="danger-btn small" type="button" data-action="delete-project" data-id="${project.id}">删除</button>
  </td>
</tr>`).join('');
  projectRows.querySelectorAll('[data-action="edit-project"]').forEach((button) => {
    button.addEventListener('click', () => openProjectEditor(projects.find((p) => p.id === button.dataset.id)));
  });
  projectRows.querySelectorAll('[data-action="delete-project"]').forEach((button) => {
    button.addEventListener('click', () => deleteProjectRow(button.dataset.id));
  });
}

function openProjectEditor(project) {
  editingProject = project || null;
  projectForm.reset();
  for (const field of projectFields) {
    const input = projectForm.elements.namedItem(field);
    if (input) input.value = project ? (project[field] || '') : (field === 'priority' ? 'P2' : field === 'status' ? 'active' : '');
  }
  document.querySelector('#projectDialogTitle').textContent = project ? '编辑项目' : '新增项目';
  projectFormStatus.textContent = '';
  projectDialog.showModal();
  projectForm.elements.namedItem('name').focus();
}

async function saveProject(event) {
  event.preventDefault();
  if (!projectForm.reportValidity()) return;
  const payload = Object.fromEntries(projectFields.map((field) => [field, projectForm.elements.namedItem(field).value]));
  projectForm.dataset.saving = '1';
  projectSaveBtn.disabled = true;
  projectFormStatus.textContent = '正在保存...';
  try {
    const result = await api(editingProject ? `/api/admin/projects/${editingProject.id}` : '/api/admin/projects', {
      method: editingProject ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    projects = editingProject
      ? projects.map((p) => (p.id === result.project.id ? result.project : p))
      : [...projects, result.project];
    renderProjects();
    await refreshAuditLogs();
    showToast(editingProject ? '项目已更新' : '项目已创建', projectSaveBtn);
    closeDialogAnimated(projectDialog);
  } catch (error) {
    projectFormStatus.textContent = error.message;
  } finally {
    delete projectForm.dataset.saving;
    projectSaveBtn.disabled = false;
  }
}

async function deleteProjectRow(projectId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project || !window.confirm(`确认删除项目「${project.name}」？成本台账里已经用到这个项目名的记录不会被删除，但监督agent和数据大屏会立刻看不到它。`)) return;
  projectListStatus.textContent = '正在删除...';
  try {
    await api(`/api/admin/projects/${projectId}`, { method: 'DELETE' });
    projects = projects.filter((p) => p.id !== projectId);
    renderProjects();
    await refreshAuditLogs();
    projectListStatus.textContent = '';
  } catch (error) {
    projectListStatus.textContent = error.message;
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

