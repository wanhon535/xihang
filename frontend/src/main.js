import { api, createSsoUrl, logout, redirectToLogin, requireUser } from './api.js';

const content = document.querySelector('#content');
const userName = document.querySelector('#userName');
const accountName = document.querySelector('#accountName');
const accountRole = document.querySelector('#accountRole');
const groupCount = document.querySelector('#groupCount');
const siteCount = document.querySelector('#siteCount');
const searchInput = document.querySelector('#searchInput');
const logoutBtn = document.querySelector('#logoutBtn');
let allGroups = [];

logoutBtn.addEventListener('click', logout);
searchInput.addEventListener('input', () => renderGroups(filterGroups(allGroups, searchInput.value)));

init();

async function init() {
  try {
    const user = await requireUser();
    if (!user) {
      return;
    }

    userName.textContent = user.nick || '钉钉用户';
    accountName.textContent = user.nick || '钉钉用户';
    accountRole.textContent = user.role === 'admin' ? '管理员' : '普通成员';
    document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', user.role !== 'admin'));

    const payload = await api('/api/nav/groups');
    allGroups = payload.groups || [];
    groupCount.textContent = allGroups.length;
    siteCount.textContent = allGroups.reduce((total, group) => total + (group.sites || []).length, 0);
    renderGroups(allGroups);
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    content.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
  }
}

function renderGroups(groups) {
  if (groups.length === 0) {
    content.innerHTML = '<div class="empty-card">暂无导航数据，请管理员进入后台配置。</div>';
    return;
  }

  content.className = '';
  content.innerHTML = groups
    .map(
      (group) => `<section class="group">
  <div class="group-head"><div><h2>${escapeHtml(group.name)}</h2><p>${escapeHtml(group.description)}</p></div></div>
  <div class="grid">${renderSites(group.sites || [])}</div>
</section>`
    )
    .join('');
}

function renderSites(sites) {
  if (sites.length === 0) {
    return '<p class="muted">该分组暂无站点。</p>';
  }

  return sites
    .map(
      (site) => `<a class="site-card" href="${escapeHtml(createSsoUrl(site.url))}" target="_blank" rel="noreferrer">
  <div class="site-top"><i>${escapeHtml(getInitial(site.name))}</i><div class="site-title">${escapeHtml(site.name)}<span>访问</span></div></div>
  <p>${escapeHtml(site.description)}</p>
  <div class="tags">${(site.tags || []).map((tag) => `<b>${escapeHtml(tag)}</b>`).join('')}</div>
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

function getInitial(name = '') {
  return String(name).trim().slice(0, 1).toUpperCase() || '站';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
