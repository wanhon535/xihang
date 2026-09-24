import { initAppearance } from './appearance.js';
import { mountSeasonalParticles, setSeasonalParticleUser } from './seasonal-particles.js';
// Shared workspace chrome. This module deliberately makes no API requests;
// pages that already have data to show (e.g. admin.js and its audit log) push
// it in through setNotifications() instead of shell.js fetching anything itself.
const body = document.body;
let syncHeading = () => {};
let setNotificationsImpl = () => {};
let tabBarDecorate = () => {};
let appearanceApi = null;

function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function writeSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch {}
}

if (body.classList.contains('vben-shell')) {
  const rail = document.querySelector('.side-rail');
  const main = document.querySelector('.console-main');
  const pageHeader = main.querySelector('.console-topbar');
  const title = pageHeader.querySelector('h1');
  const pageName = title.textContent;
  const header = document.createElement('header');
  header.className = 'workspace-header';
  header.innerHTML = `<div class="workspace-breadcrumb"><button type="button" class="shell-toggle" aria-label="收起导航" aria-expanded="true" aria-controls="workspace-sidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 9h4M13 13h4"/></svg></button><a href="/">汐航</a><span aria-hidden="true">/</span><strong class="current-page"></strong></div><div class="workspace-tools"><button type="button" id="quickSearchBtn" class="shell-icon-btn" aria-label="快速搜索（Ctrl+K）" title="快速搜索（Ctrl+K）"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></button><button type="button" id="notifyBtn" class="shell-icon-btn" aria-label="通知" title="通知" aria-expanded="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg><span class="shell-notify-dot" hidden></span></button><button type="button" id="fullscreenBtn" class="shell-icon-btn" aria-label="全屏" title="全屏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button><a href="/#app-map" class="shell-directory">应用目录 <span>↗</span></a></div>`;
  header.querySelector('.current-page').textContent = pageName;
  const actions = pageHeader.querySelector('.console-user') || pageHeader.querySelector('#logoutBtn');
  if (actions) header.querySelector('.workspace-tools').append(actions);
  const tabs = document.createElement('nav');
  tabs.className = 'workspace-tabs';
  tabs.setAttribute('aria-label', '页面导航');
  const home = document.createElement('a');
  home.href = '/'; home.textContent = '工作台'; tabs.append(home);
  const onHome = body.classList.contains('home-page');
  const current = onHome ? home : document.createElement('a');
  if (!onHome) { current.href = window.location.pathname; current.textContent = pageName; tabs.append(current); }
  current.className = 'active'; current.setAttribute('aria-current', 'page');
  const label = document.createElement('span'); label.className = 'workspace-label'; label.textContent = '汐航工作空间'; tabs.append(label);
  if (!onHome) {
    const appearance = document.createElement('button');
    appearance.type = 'button'; appearance.id = 'themeToggleBtn'; appearance.className = 'shell-appearance'; appearance.textContent = '外观';
    header.querySelector('.workspace-tools').prepend(appearance);
  }
  body.prepend(header, tabs);
  appearanceApi = initAppearance();
  mountSeasonalParticles();
  pageHeader.classList.add('page-heading');
  rail.id = 'workspace-sidebar';
  const backdrop = document.createElement('button');
  backdrop.type = 'button'; backdrop.className = 'shell-backdrop'; backdrop.setAttribute('aria-label', '关闭导航'); backdrop.hidden = true; body.append(backdrop);
  const toggle = header.querySelector('.shell-toggle');
  const mobile = window.matchMedia('(max-width: 760px)');
  function syncNavigation() {
    const expanded = mobile.matches ? body.classList.contains('nav-open') : !body.classList.contains('nav-collapsed');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? '收起导航' : '展开导航');
    backdrop.hidden = !(mobile.matches && expanded);
    rail.inert = mobile.matches && !expanded;
  }
  try { body.classList.toggle('nav-collapsed', localStorage.getItem('tidesail.sidebar.collapsed') === 'true'); } catch {}
  toggle.addEventListener('click', () => {
    body.classList.toggle(mobile.matches ? 'nav-open' : 'nav-collapsed');
    if (!mobile.matches) { try { localStorage.setItem('tidesail.sidebar.collapsed', String(body.classList.contains('nav-collapsed'))); } catch {} }
    syncNavigation();
  });
  function closeNavigation() { body.classList.remove('nav-open'); syncNavigation(); toggle.focus(); }
  backdrop.addEventListener('click', closeNavigation);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && body.classList.contains('nav-open')) closeNavigation(); });
  rail.addEventListener('click', event => { if (event.target.closest('a') && mobile.matches) closeNavigation(); });
  mobile.addEventListener('change', syncNavigation);
  syncNavigation();
  rail.querySelectorAll('a').forEach(link => { link.title = link.textContent.trim(); if (link.classList.contains('active')) link.setAttribute('aria-current', 'page'); });
  syncHeading = () => {
    header.querySelector('.current-page').textContent = title.textContent;
    current.textContent = title.textContent;
    if (!onHome) current.href = window.location.pathname + window.location.hash;
  };

  initFullscreenToggle(header.querySelector('#fullscreenBtn'));
  initNotifications(header.querySelector('#notifyBtn'));
  initTabBar(tabs, home);
  // Search indexes whatever pages/panels setWorkspaceUser and the current page expose.
  initQuickSearch(header.querySelector('#quickSearchBtn'));
}

// Pages that rewrite their <h1> after load (e.g. switching admin panels) call this
// to keep the breadcrumb and active workspace tab label in sync with it.
export function syncActiveHeading() {
  syncHeading();
}

// Pages that already loaded data with a natural "recent activity" shape (e.g.
// admin.js's audit log) can surface it in the shared notification bell.
export function setNotifications(items) {
  setNotificationsImpl(items);
}

function initFullscreenToggle(button) {
  if (!button) return;
  function sync() {
    const active = Boolean(document.fullscreenElement);
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? '退出全屏' : '全屏';
    button.setAttribute('aria-label', button.title);
  }
  button.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener('fullscreenchange', sync);
  sync();
}

function initNotifications(button) {
  if (!button) return;
  const panel = document.createElement('div');
  panel.className = 'shell-notify-panel';
  panel.hidden = true;
  panel.innerHTML = '<h3>通知</h3><div class="shell-notify-list"></div>';
  document.body.append(panel);
  const list = panel.querySelector('.shell-notify-list');
  const dot = button.querySelector('.shell-notify-dot');
  renderEmpty();

  function renderEmpty() {
    list.innerHTML = '<p class="shell-notify-empty">暂无通知。管理员操作会出现在这里。</p>';
  }

  setNotificationsImpl = (items) => {
    if (!Array.isArray(items) || !items.length) { renderEmpty(); dot.hidden = true; return; }
    list.innerHTML = items.slice(0, 5).map(item => `<div class="shell-notify-item"><strong>${escapeHtml(item.title || '')}</strong><span>${escapeHtml(item.time || '')}</span></div>`).join('');
    dot.hidden = false;
  };

  function close() { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  function open() {
    const rect = button.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.right = `${Math.max(16, window.innerWidth - rect.right)}px`;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    dot.hidden = true;
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    panel.hidden ? open() : close();
  });
  document.addEventListener('click', (event) => { if (!panel.hidden && !panel.contains(event.target)) close(); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !panel.hidden) close(); });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Quick search: a small command palette over the sidebar pages and,
// on pages that expose data-admin-panel triggers, their panels too. ----
let searchIndex = [];
function initQuickSearch(button) {
  if (!button) return;
  const overlay = document.createElement('div');
  overlay.className = 'shell-search-backdrop';
  overlay.hidden = true;
  overlay.innerHTML = '<div class="shell-search-panel" role="dialog" aria-label="快速搜索"><input type="text" placeholder="搜索页面或功能…" aria-label="搜索"><div class="shell-search-results"></div></div>';
  document.body.append(overlay);
  const input = overlay.querySelector('input');
  const results = overlay.querySelector('.shell-search-results');
  let activeIndex = 0;
  let matches = [];

  function render(query) {
    const q = query.trim().toLocaleLowerCase();
    matches = !q ? searchIndex : searchIndex.filter(item => item.label.toLocaleLowerCase().includes(q));
    activeIndex = 0;
    results.innerHTML = matches.length
      ? matches.map((item, i) => `<button type="button" data-index="${i}" class="${i === 0 ? 'active' : ''}">${escapeHtml(item.label)}</button>`).join('')
      : '<p class="shell-search-empty">没有匹配的页面或功能。</p>';
  }
  function highlight() {
    [...results.querySelectorAll('button')].forEach((btn, i) => btn.classList.toggle('active', i === activeIndex));
  }
  function go(item) { close(); window.location.href = item.href; }
  function close() { overlay.hidden = true; input.value = ''; }
  function open() {
    overlay.hidden = false;
    render('');
    input.focus();
  }

  button.addEventListener('click', open);
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); overlay.hidden ? open() : close(); }
    else if (event.key === 'Escape' && !overlay.hidden) close();
  });
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = Math.min(activeIndex + 1, matches.length - 1); highlight(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); highlight(); }
    else if (event.key === 'Enter' && matches[activeIndex]) go(matches[activeIndex]);
  });
  results.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-index]');
    if (btn) go(matches[Number(btn.dataset.index)]);
  });
}

// ---- Tab bar: pin / close / close-others / close-all via right-click, matching
// the vben-admin multi-tab convention as far as a full-page-reload MPA allows. ----
function initTabBar(tabs, home) {
  const menu = document.createElement('div');
  menu.className = 'shell-tab-menu';
  menu.hidden = true;
  document.body.append(menu);
  function closeMenu() { menu.hidden = true; }
  document.addEventListener('click', closeMenu);
  window.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

  function decorate(tab, href, isHome) {
    if (tab.dataset.tabReady) { updateCloseButton(tab, href, isHome); return; }
    tab.dataset.tabReady = '1';
    tab.dataset.href = href;
    updateCloseButton(tab, href, isHome);
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY, tab, href, isHome);
    });
  }

  function updateCloseButton(tab, href, isHome) {
    const pinned = isHome || readSet('tidesail.tabs.pinned').has(href);
    tab.classList.toggle('pinned', pinned);
    let closeBtn = tab.querySelector('.tab-close');
    if (pinned) { closeBtn?.remove(); return; }
    if (!closeBtn) {
      // A <span role="button"> rather than a real <button>: a tab is an <a>, and
      // nesting interactive content (button/a/...) inside an <a> is invalid HTML.
      closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close'; closeBtn.setAttribute('role', 'button'); closeBtn.tabIndex = 0;
      closeBtn.setAttribute('aria-label', '关闭标签'); closeBtn.textContent = '×';
      const trigger = (event) => { event.preventDefault(); event.stopPropagation(); closeTab(href); };
      closeBtn.addEventListener('click', trigger);
      closeBtn.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') trigger(event); });
      tab.append(closeBtn);
    }
  }

  function closeTab(href) {
    const closed = readSet('tidesail.tabs.closed');
    closed.add(href);
    writeSet('tidesail.tabs.closed', closed);
    if (window.location.pathname === href) { window.location.href = '/'; return; }
    tabs.querySelector(`a[data-href="${CSS.escape(href)}"]`)?.remove();
  }

  function closeOthers(keepHref) {
    const closed = readSet('tidesail.tabs.closed');
    const pinned = readSet('tidesail.tabs.pinned');
    [...tabs.querySelectorAll('a[data-href]')].forEach(tab => {
      const href = tab.dataset.href;
      if (href === keepHref || href === '/' || href === window.location.pathname || pinned.has(href)) return;
      closed.add(href);
      tab.remove();
    });
    writeSet('tidesail.tabs.closed', closed);
  }

  function openMenu(x, y, tab, href, isHome) {
    const pinned = isHome || readSet('tidesail.tabs.pinned').has(href);
    const items = [
      { label: '刷新', action: () => { window.location.pathname === href ? window.location.reload() : (window.location.href = href); } }
    ];
    if (!isHome) items.push({ label: pinned ? '取消固定' : '固定标签', action: () => togglePin(href) });
    if (!pinned) items.push({ label: '关闭', action: () => closeTab(href) });
    items.push({ label: '关闭其他', action: () => closeOthers(href) });
    items.push({ label: '关闭全部', action: () => closeOthers(window.location.pathname) });
    menu.innerHTML = items.map((item, i) => `<button type="button" data-index="${i}">${escapeHtml(item.label)}</button>`).join('');
    menu.querySelectorAll('button').forEach((btn, i) => btn.addEventListener('click', (event) => { event.stopPropagation(); closeMenu(); items[i].action(); }));
    menu.hidden = false;
    const maxLeft = window.innerWidth - menu.offsetWidth - 8;
    menu.style.left = `${Math.min(x, Math.max(8, maxLeft))}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  }

  function togglePin(href) {
    const pinned = readSet('tidesail.tabs.pinned');
    pinned.has(href) ? pinned.delete(href) : pinned.add(href);
    writeSet('tidesail.tabs.pinned', pinned);
    tabs.querySelector(`a[data-href="${CSS.escape(href)}"]`) && updateCloseButton(tabs.querySelector(`a[data-href="${CSS.escape(href)}"]`), href, false);
  }

  decorate(home, '/', true);
  tabBarDecorate = decorate;
}

// A single authenticated navigation model for every internal page.
export function setWorkspaceUser(user) {
  const allowed = user.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(node => node.classList.toggle('hidden', !allowed));
  const nav = document.querySelector('.side-nav');
  const tabs = document.querySelector('.workspace-tabs');
  const notifyBtn = document.querySelector('#notifyBtn');
  if (notifyBtn) notifyBtn.hidden = !allowed;
  const pages = [['/', '工作台'], ['/vault.html', '星钥库'], ...(allowed ? [['/admin.html', '管理中枢'], ['/ledger.html', '成本台账'], ['/screen.html', '数据大屏']] : [])];
  const closed = readSet('tidesail.tabs.closed');
  const currentPath = window.location.pathname;
  if (closed.has(currentPath)) { closed.delete(currentPath); writeSet('tidesail.tabs.closed', closed); }
  for (const [href, name] of pages) {
    let link = [...nav.querySelectorAll(':scope > a')].find(node => node.getAttribute('href') === href);
    if (!link) {
      link = document.createElement('a'); link.href = href;
      link.innerHTML = '<b><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h4"/></svg></b><span></span>';
      link.querySelector('span').textContent = name;
      nav.insertBefore(link, nav.querySelector('.nav-group'));
    }
    link.classList.remove('hidden'); link.classList.add('primary-navigation-link');
    if (window.location.pathname === href) link.classList.add('active');
    if (href === '/') continue; // the home tab is always created up-front and always shown
    if (closed.has(href) && href !== currentPath) { tabs.querySelector(`a[data-href="${CSS.escape(href)}"]`)?.remove(); continue; }
    let tab = [...tabs.querySelectorAll('a')].find(node => new URL(node.href).pathname === href);
    if (!tab) { tab = document.createElement('a'); tab.href = href; tab.textContent = name; tabs.insertBefore(tab, tabs.querySelector('.workspace-label')); }
    tabBarDecorate(tab, href, false);
  }
  nav.prepend(...pages.map(([href]) => [...nav.querySelectorAll(':scope > a')].find(link => link.getAttribute('href') === href)));
  for (const [href] of pages) {
    const tab = [...tabs.querySelectorAll('a')].find(link => new URL(link.href).pathname === href);
    tab && tabs.insertBefore(tab, tabs.querySelector('.workspace-label'));
  }
  searchIndex = [
    ...pages.map(([href, name]) => ({ label: name, href })),
    ...[...document.querySelectorAll('[data-admin-panel]')].map(el => ({ label: el.textContent.trim(), href: `${window.location.pathname}#${el.dataset.adminPanel}` }))
  ];
  try { setSeasonalParticleUser(user); } catch { /* Optional decoration must not interrupt the workspace. */ }
  void appearanceApi?.load(user);
}
