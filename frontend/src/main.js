import { api, createSsoUrl, logout, redirectToLogin, requireUser } from './api.js';

const content = document.querySelector('#content');
const userName = document.querySelector('#userName');
const accountName = document.querySelector('#accountName');
const accountRole = document.querySelector('#accountRole');
const groupCount = document.querySelector('#groupCount');
const siteCount = document.querySelector('#siteCount');
const keyCount = document.querySelector('#keyCount');
const visitCount = document.querySelector('#visitCount');
const directorySummary = document.querySelector('#directorySummary');
const searchInput = document.querySelector('#searchInput');
const logoutBtn = document.querySelector('#logoutBtn');
let allGroups = [];

logoutBtn.addEventListener('click', logout);
searchInput.addEventListener('input', () => {
  const groups = filterGroups(allGroups, searchInput.value);
  renderGroups(groups);
  updateDirectorySummary(groups, searchInput.value);
});

init();

async function init() {
  try {
    const user = await requireUser();
    if (!user) {
      return;
    }

    const displayName = user.nick || user.username || '汐航用户';
    userName.textContent = displayName;
    accountName.textContent = displayName;
    accountRole.textContent = user.role === 'admin' ? '管理员' : '普通成员';
    document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', user.role !== 'admin'));

    const payload = await api('/api/nav/groups');
    allGroups = payload.groups || [];
    groupCount.textContent = allGroups.length;
    siteCount.textContent = countSites(allGroups);
    visitCount.textContent = String(Math.min(countSites(allGroups), 12));
    loadKeyCount();
    renderGroups(allGroups);
    updateDirectorySummary(allGroups, '');
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    content.className = 'workspace-empty';
    content.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

async function loadKeyCount() {
  if (!keyCount) {
    return;
  }

  try {
    const payload = await api('/api/vault/credentials');
    keyCount.textContent = String((payload.credentials || []).length);
  } catch {
    keyCount.textContent = '0';
  }
}

function renderGroups(groups) {
  if (groups.length === 0) {
    content.className = 'workspace-empty';
    content.innerHTML = '<p>暂时没有匹配的站点。可以换个关键词试试，管理员也可以在后台补充新的入口。</p>';
    return;
  }

  content.className = 'system-sections';
  content.innerHTML = groups
    .map(
      (group) => `<section class="system-section">
  <div class="system-section-head">
    <div>
      <h3>${escapeHtml(group.name)}</h3>
      <p>${escapeHtml(group.description || '已经整理好的内部系统入口')}</p>
    </div>
    <span>${(group.sites || []).length} 个入口在线</span>
  </div>
  <div class="system-grid">${renderSites(group.sites || [])}</div>
</section>`
    )
    .join('');
}

function renderSites(sites) {
  if (sites.length === 0) {
    return '<p class="section-empty">这个分组还没有站点，等管理员放入新的入口。</p>';
  }

  return sites
    .map(
      (site) => `<a class="system-card" href="${escapeHtml(createSsoUrl(site.url))}" target="_blank" rel="noreferrer">
  <span class="system-icon">${escapeHtml(getInitial(site.name))}</span>
  <div class="system-card-body">
    <strong>${escapeHtml(site.name)}</strong>
    <p>${escapeHtml(site.description || '安全打开这个内部系统')}</p>
  </div>
  <div class="system-card-foot">
    <div class="system-tags">${(site.tags || []).map((tag) => `<b>${escapeHtml(tag)}</b>`).join('')}</div>
    <span class="system-open">进入</span>
  </div>
</a>`
    )
    .join('');
}

function filterGroups(groups, keyword) {
  const query = keyword.trim().toLowerCase();
  if (!query) {
    return groups;
  }

  return groups
    .map((group) => ({
      ...group,
      sites: (group.sites || []).filter((site) => {
        const text = `${site.name} ${site.description} ${(site.tags || []).join(' ')}`.toLowerCase();
        return text.includes(query);
      })
    }))
    .filter((group) => group.sites.length > 0);
}

function updateDirectorySummary(groups, keyword) {
  const total = countSites(groups);
  directorySummary.textContent = keyword.trim()
    ? `已为你筛出 ${total} 个入口`
    : `已连接 ${groups.length} 个应用星区，${total} 个站点入口`;
}

function countSites(groups) {
  return groups.reduce((total, group) => total + (group.sites || []).length, 0);
}

function getInitial(name = '') {
  return String(name).trim().slice(0, 1).toUpperCase() || '星';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
