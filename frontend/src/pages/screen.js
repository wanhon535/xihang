import { setWorkspaceUser } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';
import { money } from '../ledger-utils.js';

const $ = id => document.getElementById(id);
const AUTO_REFRESH_SECONDS = 30;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * 50;
let user = null;
let autoRefreshOn = true;
let countdown = AUTO_REFRESH_SECONDS;
let countdownTimer = null;
let expandedProject = null;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('ledger-error', error);
}

function handleAuth(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  user = null;
  $('screenWorkspace').hidden = true;
  if (error.code === 'PASSWORD_CHANGE_REQUIRED') window.location.href = '/change-password.html';
  else if (error.status === 401) redirectToLogin('登录已失效，请重新登录。');
  else status('当前账号没有数据大屏权限。', true);
  return true;
}

function priorityLabel(priority) {
  return priority && /^P[0-3]$/.test(priority) ? priority : '未设置';
}

// ---- Live clock ----
function startClock() {
  function tick() {
    const now = new Date();
    $('screenClock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
    $('screenDate').textContent = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }
  tick();
  setInterval(tick, 1000);
}

// ---- Count-up numbers: cheap visual interest, not just static labels ----
function animateCount(el, target, { decimals = 0 } = {}) {
  const format = (value) => value.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const from = Number(el.dataset.target || 0);
  const to = Number(target) || 0;
  el.dataset.target = to;
  // requestAnimationFrame is throttled/paused for hidden or unfocused tabs (e.g. the
  // page loaded or auto-refreshed in a background tab), which would otherwise leave
  // the number stuck at its starting value indefinitely instead of just skipping the
  // animation.
  if (from === to || document.hidden) { el.textContent = format(to); return; }
  const duration = 700;
  const start = performance.now();
  function step(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const value = from + (to - from) * eased;
    el.textContent = format(value);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ---- Auto-refresh with a visible countdown; pausable ----
function startAutoRefresh() {
  countdownTimer = setInterval(() => {
    if (!autoRefreshOn) return;
    countdown -= 1;
    if (countdown <= 0) {
      countdown = AUTO_REFRESH_SECONDS;
      loadScreen();
    }
    $('autoRefreshCountdown').textContent = `${countdown}s`;
  }, 1000);
}

$('autoRefreshBtn').addEventListener('click', () => {
  autoRefreshOn = !autoRefreshOn;
  countdown = AUTO_REFRESH_SECONDS;
  $('autoRefreshBtn').setAttribute('aria-pressed', String(autoRefreshOn));
  $('autoRefreshBtn').classList.toggle('is-paused', !autoRefreshOn);
  $('autoRefreshCountdown').textContent = autoRefreshOn ? `${countdown}s` : '已暂停';
});

function renderProjects(projects) {
  animateCount($('kpiActive'), projects.active);
  animateCount($('kpiStalled'), projects.stalled);
  animateCount($('kpiNearMilestone'), projects.nearMilestone);

  const rows = $('projectRows');
  rows.replaceChildren();
  $('projectEmpty').hidden = projects.items.length > 0;
  expandedProject = null;

  for (const item of projects.items) {
    const tr = document.createElement('tr');
    tr.className = 'screen-project-row';
    tr.tabIndex = 0;
    const badges = [];
    if (item.isStalled) badges.push(`<span class="screen-badge screen-badge-danger">停滞 ${item.staleDays} 天</span>`);
    if (item.isNearMilestone) badges.push('<span class="screen-badge screen-badge-warning">临近节点</span>');
    if (!badges.length) badges.push('<span class="screen-badge screen-badge-ok">正常</span>');
    tr.innerHTML = `<td>${escapeHtml(item.name)}</td><td>${escapeHtml(priorityLabel(item.priority))}</td><td>${escapeHtml(item.lastUpdate || '—')}</td><td>${escapeHtml(item.nextMilestone || '—')}</td><td>${badges.join(' ')}</td>`;
    const toggle = () => toggleProjectDetail(tr, item);
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    rows.append(tr);
  }
}

function toggleProjectDetail(tr, item) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains('screen-project-detail')) { next.remove(); expandedProject = null; return; }
  document.querySelectorAll('.screen-project-detail').forEach(node => node.remove());
  expandedProject = item.name;
  const detail = document.createElement('tr');
  detail.className = 'screen-project-detail';
  detail.innerHTML = `<td colspan="5">${escapeHtml(item.note || '暂无备注。')}</td>`;
  tr.after(detail);
}

function renderCost(cost) {
  const total = Number(cost.totalCents) || 0;
  const paid = Number(cost.paidCents) || 0;
  const ratio = total > 0 ? paid / total : 0;

  animateCount($('kpiTotalCost'), total / 100, { decimals: 0 });
  $('kpiPaidCost').textContent = money(cost.paidCents);
  $('kpiUnpaidCost').textContent = money(cost.unpaidCents);
  $('paymentPercent').textContent = `${Math.round(ratio * 100)}%`;
  const donut = $('paymentDonutFill');
  donut.style.strokeDasharray = String(DONUT_CIRCUMFERENCE);
  donut.style.strokeDashoffset = String(DONUT_CIRCUMFERENCE * (1 - ratio));

  const maxCategory = Math.max(1, ...cost.byCategory.map(c => Number(c.amountCents)));
  $('costByCategory').replaceChildren(...cost.byCategory.map(c => renderBar(c.category, c.amountCents, maxCategory)));
  if (!cost.byCategory.length) $('costByCategory').append(emptyBarNote('暂无成本记录'));

  const maxMonth = Math.max(1, ...cost.byMonth.map(m => Number(m.amountCents)));
  $('costByMonth').replaceChildren(...cost.byMonth.map(m => renderBar(m.month, m.amountCents, maxMonth)));
  if (!cost.byMonth.length) $('costByMonth').append(emptyBarNote('近 6 个月暂无成本记录'));
}

function renderBar(label, amountCents, max) {
  const row = document.createElement('div');
  row.className = 'screen-bar-row';
  const percent = Math.max(2, Math.round((Number(amountCents) / max) * 100));
  row.innerHTML = `<span class="screen-bar-label">${escapeHtml(label)}</span><span class="screen-bar-track"><span class="screen-bar-fill" style="width:${percent}%"></span></span><span class="screen-bar-value">${money(amountCents)}</span>`;
  return row;
}

function emptyBarNote(text) {
  const p = document.createElement('p');
  p.className = 'screen-empty';
  p.textContent = text;
  return p;
}

function renderDataFlow(dataFlow) {
  $('dataFlowNote').textContent = dataFlow.note || '暂无数据。';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadScreen() {
  try {
    const payload = await api('/api/admin/dashboard/screen');
    renderProjects(payload.projects);
    renderCost(payload.cost);
    renderDataFlow(payload.dataFlow);
    $('screenUpdated').textContent = `最近更新 ${new Date(payload.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    status('');
  } catch (error) {
    if (!handleAuth(error)) status(`数据加载失败：${error.message}`, true);
  }
}

$('refreshBtn').addEventListener('click', () => { countdown = AUTO_REFRESH_SECONDS; loadScreen(); });
$('logoutBtn').addEventListener('click', async () => {
  try { await logout(); } catch (error) { if (!handleAuth(error)) status(`退出失败：${error.message}`, true); }
});

async function init() {
  try {
    user = await requireUser();
    if (!user) return;
    if (user.role !== 'admin') {
      user = null;
      status('当前账号没有数据大屏权限。', true);
      return;
    }
    setWorkspaceUser(user);
    $('userName').textContent = user.nick || user.username || '管理员';
    $('screenWorkspace').hidden = false;
    startClock();
    startAutoRefresh();
    await loadScreen();
  } catch (error) {
    if (!handleAuth(error)) status(`身份验证失败：${error.message}。请重新加载页面。`, true);
  }
}
init();
