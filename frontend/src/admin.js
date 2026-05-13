import { api, logout, redirectToLogin, requireUser } from './api.js';

const editor = document.querySelector('#adminEditor');
const saveBtn = document.querySelector('#saveBtn');
const addGroupBtn = document.querySelector('#addGroupBtn');
const saveStatus = document.querySelector('#saveStatus');
const userName = document.querySelector('#userName');
const logoutBtn = document.querySelector('#logoutBtn');

let groups = [];

logoutBtn.addEventListener('click', logout);
addGroupBtn.addEventListener('click', () => {
  groups.push({ name: '', description: '', sites: [] });
  render();
});
saveBtn.addEventListener('click', saveGroups);

init();

async function init() {
  try {
    const user = await requireUser();
    if (!user) {
      return;
    }
    if (user.role !== 'admin') {
      redirectToLogin('当前账号没有后台权限。');
      return;
    }
    userName.textContent = user.nick || '钉钉用户';

    const payload = await api('/api/admin/groups');
    groups = payload.groups || [];
    render();
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    editor.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
  }
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

function render() {
  editor.innerHTML = '';

  if (groups.length === 0) {
    editor.appendChild(el('div', 'empty-card', '暂无分组，点击“新增分组”开始配置。'));
    return;
  }

  groups.forEach((group, groupIndex) => {
    const groupCard = el('section', 'admin-card');
    const groupTop = el('div', 'admin-card-top');
    const title = el('strong', '', `分组 ${groupIndex + 1}`);
    const actions = el('div', 'row-actions');
    const addSiteBtn = el('button', 'plain-btn small', '新增站点');
    const removeGroupBtn = el('button', 'danger-btn small', '删除分组');

    addSiteBtn.type = 'button';
    removeGroupBtn.type = 'button';
    addSiteBtn.addEventListener('click', () => {
      group.sites = group.sites || [];
      group.sites.push({ name: '', url: '', description: '', tags: [] });
      render();
    });
    removeGroupBtn.addEventListener('click', () => {
      groups.splice(groupIndex, 1);
      render();
    });

    actions.append(addSiteBtn, removeGroupBtn);
    groupTop.append(title, actions);
    groupCard.appendChild(groupTop);
    groupCard.appendChild(field('分组名称', input(group.name, '例如：产品与业务', (value) => (group.name = value))));
    groupCard.appendChild(field('分组说明', textarea(group.description, '用于说明该分组包含哪些入口', (value) => (group.description = value))));

    const sites = el('div', 'site-editor-list');
    (group.sites || []).forEach((site, siteIndex) => {
      const siteCard = el('div', 'site-editor');
      const siteTop = el('div', 'admin-card-top');
      const siteTitle = el('strong', '', `站点 ${siteIndex + 1}`);
      const removeSiteBtn = el('button', 'danger-btn small', '删除站点');
      removeSiteBtn.type = 'button';
      removeSiteBtn.addEventListener('click', () => {
        group.sites.splice(siteIndex, 1);
        render();
      });

      siteTop.append(siteTitle, removeSiteBtn);
      siteCard.appendChild(siteTop);
      siteCard.appendChild(field('站点名称', input(site.name, '例如：产品定位文档', (value) => (site.name = value))));
      siteCard.appendChild(field('访问地址', input(site.url, 'https://...', (value) => (site.url = value))));
      siteCard.appendChild(field('站点说明', textarea(site.description, '一句话说明用途', (value) => (site.description = value))));
      siteCard.appendChild(
        field(
          '标签',
          input((site.tags || []).join('，'), '多个标签用逗号分隔', (value) => {
            site.tags = value
              .split(/[,，]/)
              .map((tag) => tag.trim())
              .filter(Boolean);
          })
        )
      );
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
    render();
    saveStatus.textContent = '已保存到 MySQL，团队成员刷新首页即可看到最新配置。';
  } catch (error) {
    saveStatus.textContent = error.message;
  } finally {
    saveBtn.disabled = false;
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
