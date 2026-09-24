import { initAppearance } from './appearance.js';
// Shared workspace chrome. This module deliberately makes no API requests.
const body = document.body;
if (body.classList.contains('vben-shell')) {
  const rail = document.querySelector('.side-rail');
  const main = document.querySelector('.console-main');
  const pageHeader = main.querySelector('.console-topbar');
  const title = pageHeader.querySelector('h1');
  const pageName = title.textContent;
  const header = document.createElement('header');
  header.className = 'workspace-header';
  header.innerHTML = `<div class="workspace-breadcrumb"><button type="button" class="shell-toggle" aria-label="收起导航" aria-expanded="true" aria-controls="workspace-sidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 9h4M13 13h4"/></svg></button><a href="/">汐航</a><span aria-hidden="true">/</span><strong class="current-page"></strong></div><div class="workspace-tools"><a href="/#app-map" class="shell-directory">应用目录 <span>↗</span></a></div>`;
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
  initAppearance();
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
  new MutationObserver(() => { header.querySelector('.current-page').textContent = title.textContent; current.textContent = title.textContent; if (!onHome) current.href = window.location.pathname + window.location.hash; }).observe(title, { childList: true, characterData: true, subtree: true });
}

// A single authenticated navigation model for every internal page.
export function setWorkspaceUser(user) {
  const allowed = user.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(node => node.classList.toggle('hidden', !allowed));
  const nav = document.querySelector('.side-nav');
  const tabs = document.querySelector('.workspace-tabs');
  const pages = [['/', '工作台'], ['/vault.html', '星钥库'], ...(allowed ? [['/admin.html', '管理中枢'], ['/ledger.html', '成本台账']] : [])];
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
    const exists = [...tabs.querySelectorAll('a')].some(node => new URL(node.href).pathname === href);
    if (!exists) { const tab = document.createElement('a'); tab.href = href; tab.textContent = name; tabs.insertBefore(tab, tabs.querySelector('.workspace-label')); }
  }
  nav.prepend(...pages.map(([href]) => [...nav.querySelectorAll(':scope > a')].find(link => link.getAttribute('href') === href)));
  for (const [href] of pages) {
    const tab = [...tabs.querySelectorAll('a')].find(link => new URL(link.href).pathname === href);
    tabs.insertBefore(tab, tabs.querySelector('.workspace-label'));
  }

}
