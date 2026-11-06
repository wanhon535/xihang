// 汐航 · API 模块（令牌管理 + 数据面板）
// 普通用户：管理自己的令牌；管理员：可看全站、可代建。
import { setWorkspaceUser } from '../shell.js';
import { api, logout, requireUser } from '../api.js';
import { showToast } from '../ui-feedback.js';

const $ = (sel) => document.querySelector(sel);

const userName = $('#userName');
const logoutBtn = $('#logoutBtn');

// 数据面板
const apiStatGrid = $('#apiStatGrid');
const statTokenTotal = $('#statTokenTotal');
const statTokenSub = $('#statTokenSub');
const statCalls24h = $('#statCalls24h');
const statCallsSub = $('#statCallsSub');
const statCalls7d = $('#statCalls7d');
const statFailSub = $('#statFailSub');
const statFailRate = $('#statFailRate');
const apiTrendChart = $('#apiTrendChart');
const apiModuleBreakdown = $('#apiModuleBreakdown');
const statsScopeSwitch = $('#statsScopeSwitch');
const tokenScopeSwitch = $('#tokenScopeSwitch');

// 创建表单
const apiTokenForm = $('#apiTokenForm');
const apiTokenNameInput = $('#apiTokenNameInput');
const apiTokenExpiryInput = $('#apiTokenExpiryInput');
const apiTokenOwnerField = $('#apiTokenOwnerField');
const apiTokenOwnerInput = $('#apiTokenOwnerInput');
const apiPermissionTree = $('#apiPermissionTree');
const createApiTokenBtn = $('#createApiTokenBtn');
const apiTokenFormStatus = $('#apiTokenFormStatus');

// 明文展示
const apiTokenReveal = $('#apiTokenReveal');
const apiTokenRevealValue = $('#apiTokenRevealValue');
const copyApiTokenBtn = $('#copyApiTokenBtn');
const apiTokenRevealCloseBtn = $('#apiTokenRevealCloseBtn');
const copyApiTokenStatus = $('#copyApiTokenStatus');

// 列表与日志
const apiTokenList = $('#apiTokenList');
const apiLogBody = $('#apiLogBody');
const apiLogHint = $('#apiLogHint');

let catalog = { isAdmin: false, modules: [], selfServiceScopes: [] };
let isAdmin = false;
let currentRevealToken = '';

// ---------------------------------------------------------------------------
// 复制：优先 clipboard API，失败降级 execCommand（HTTP 环境必需）
// ---------------------------------------------------------------------------
async function copyText(text) {
  if (!text) return false;

  // 现代 API 只在安全上下文（HTTPS / localhost）可用
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 继续走降级方案
    }
  }

  // 降级：临时 textarea + execCommand，兼容 HTTP 页面
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);

    const selection = document.getSelection();
    const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');

    document.body.removeChild(textarea);
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    return ok;
  } catch {
    return false;
  }
}

// 兜底：自动选中内容，提示用户手动复制
function selectElementText(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    /* 忽略 */
  }
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function tokenState(token) {
  if (token.revokedAt) return { key: 'revoked', label: '已吊销' };
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return { key: 'expired', label: '已过期' };
  if (token.expiresAt) return { key: 'active', label: '有效' };
  return { key: 'active', label: '长期有效' };
}

// 把 scope key 翻成「模块 · 权限」的可读标签
function scopeLabel(scope) {
  for (const module of catalog.modules || []) {
    const found = module.permissions.find((p) => p.key === scope);
    if (found) return `${module.label} · ${found.label}`;
  }
  return scope;
}

// ---------------------------------------------------------------------------
// 权限树
// ---------------------------------------------------------------------------
function renderPermissionTree() {
  if (!apiPermissionTree) return;

  const allowed = isAdmin ? null : new Set(catalog.selfServiceScopes || []);
  const modules = catalog.modules || [];

  if (modules.length === 0) {
    apiPermissionTree.innerHTML = '<p class="muted">暂无可用权限。</p>';
    return;
  }

  apiPermissionTree.innerHTML = modules
    .map((module) => {
      const perms = module.permissions
        .map((perm) => {
          const locked = allowed ? !allowed.has(perm.key) : false;
          const riskTag = perm.risk === 'high' || perm.risk === 'critical'
            ? `<span class="api-risk is-${perm.risk}">${perm.risk === 'critical' ? '极高危' : '高危'}</span>`
            : '';
          return `
            <label class="api-perm-item ${locked ? 'is-locked' : ''}">
              <input type="checkbox" name="apiScope" value="${escapeHtml(perm.key)}"
                data-module="${escapeHtml(module.key)}" ${locked ? 'disabled' : ''} />
              <span>
                <b>${escapeHtml(perm.label)}</b>${riskTag}
                <small>${escapeHtml(perm.description)}</small>
              </span>
            </label>
          `;
        })
        .join('');

      const adminOnlyNote = module.key === 'admin' && !isAdmin
        ? '<span class="api-module-lock">仅管理员</span>'
        : '';

      return `
        <div class="api-perm-module">
          <div class="api-perm-module-head">
            <label class="api-perm-module-toggle">
              <input type="checkbox" data-module-toggle="${escapeHtml(module.key)}" />
              <strong>${escapeHtml(module.label)}</strong>
            </label>
            ${adminOnlyNote}
            <small>${escapeHtml(module.description)}</small>
          </div>
          <div class="api-perm-items">${perms}</div>
        </div>
      `;
    })
    .join('');

  // 默认勾选最小权限：第一个未被锁定的权限
  const firstEnabled = apiPermissionTree.querySelector('input[name="apiScope"]:not([disabled])');
  if (firstEnabled) firstEnabled.checked = true;
}

// 模块级全选联动
if (apiPermissionTree) {
  apiPermissionTree.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-module-toggle]');
    if (toggle) {
      const moduleKey = toggle.getAttribute('data-module-toggle');
      apiPermissionTree
        .querySelectorAll(`input[name="apiScope"][data-module="${moduleKey}"]:not([disabled])`)
        .forEach((box) => { box.checked = toggle.checked; });
      return;
    }

    // 单个权限变化时同步模块勾选态
    const box = event.target.closest('input[name="apiScope"]');
    if (box) {
      const moduleKey = box.getAttribute('data-module');
      const boxes = [...apiPermissionTree.querySelectorAll(`input[name="apiScope"][data-module="${moduleKey}"]:not([disabled])`)];
      const moduleToggle = apiPermissionTree.querySelector(`[data-module-toggle="${moduleKey}"]`);
      if (moduleToggle) moduleToggle.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    }
  });
}

// ---------------------------------------------------------------------------
// 数据面板
// ---------------------------------------------------------------------------
function renderTrend(trend) {
  if (!apiTrendChart) return;
  if (!trend || trend.length === 0) {
    apiTrendChart.innerHTML = '<span class="muted">暂无调用数据</span>';
    return;
  }

  const max = Math.max(...trend.map((d) => d.calls), 1);
  apiTrendChart.innerHTML = trend
    .map((d) => {
      const height = Math.round((d.calls / max) * 100);
      const label = `${d.day.slice(5)} · ${d.calls} 次`;
      return `<div class="api-trend-bar" title="${escapeHtml(label)}">
        <i style="height:${Math.max(height, d.calls > 0 ? 6 : 2)}%"></i>
        <span>${escapeHtml(d.day.slice(8))}</span>
      </div>`;
    })
    .join('');
}

function renderModuleBreakdown(rows) {
  if (!apiModuleBreakdown) return;
  if (!rows || rows.length === 0) {
    apiModuleBreakdown.innerHTML = '<span class="muted">暂无调用数据</span>';
    return;
  }

  const max = Math.max(...rows.map((r) => r.calls), 1);
  const moduleLabel = (key) => (catalog.modules || []).find((m) => m.key === key)?.label || key || '(未知)';

  apiModuleBreakdown.innerHTML = rows
    .map((row) => `
      <div class="api-breakdown-row">
        <span class="api-breakdown-name">${escapeHtml(moduleLabel(row.module))}</span>
        <span class="api-breakdown-bar"><i style="width:${Math.round((row.calls / max) * 100)}%"></i></span>
        <b>${row.calls}</b>
      </div>
    `)
    .join('');
}

async function loadStats(scope = 'self') {
  try {
    const payload = await api(`/api/api-center/stats?scope=${encodeURIComponent(scope)}`);
    const s = payload.stats || {};
    const tokens = s.tokens || {};
    const calls = s.calls || {};

    if (statTokenTotal) statTokenTotal.textContent = tokens.total ?? 0;
    if (statTokenSub) {
      statTokenSub.textContent = scope === 'all'
        ? `${tokens.owners ?? 0} 位成员持有`
        : `${tokens.active ?? 0} 个有效 · ${tokens.revoked ?? 0} 个吊销`;
    }
    if (statCalls24h) statCalls24h.textContent = calls.last24h ?? 0;
    if (statCallsSub) statCallsSub.textContent = `累计 ${calls.total ?? 0} 次`;
    if (statCalls7d) statCalls7d.textContent = calls.last7d ?? 0;
    if (statFailSub) statFailSub.textContent = `失败 ${calls.failed ?? 0} 次`;
    if (statFailRate) {
      const total = Number(calls.total) || 0;
      const failed = Number(calls.failed) || 0;
      statFailRate.textContent = total > 0 ? `${((failed / total) * 100).toFixed(1)}%` : '0%';
    }

    renderTrend(s.trend);
    renderModuleBreakdown(s.byModule);
  } catch (error) {
    if (apiTrendChart) apiTrendChart.innerHTML = `<span class="muted">统计加载失败：${escapeHtml(error.message)}</span>`;
  }
}

// 面板「我的 / 全站」切换
function bindScopeSwitch(el, onChange) {
  if (!el) return;
  el.addEventListener('click', (event) => {
    const btn = event.target.closest('.scope-btn');
    if (!btn) return;
    el.querySelectorAll('.scope-btn').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.getAttribute('data-scope'));
  });
}

// ---------------------------------------------------------------------------
// 令牌列表
// ---------------------------------------------------------------------------
function renderTokenList(tokens, scope) {
  if (!apiTokenList) return;

  if (!tokens || tokens.length === 0) {
    apiTokenList.innerHTML = scope === 'all'
      ? '<div class="api-token-empty">全站还没有任何 API 令牌。</div>'
      : '<div class="api-token-empty">你还没有 API 令牌，创建后即可让外部系统调用汐航。</div>';
    return;
  }

  apiTokenList.innerHTML = tokens
    .map((token) => {
      const state = tokenState(token);
      const scopes = (token.scopes || [])
        .map((s) => `<span class="api-scope-chip">${escapeHtml(scopeLabel(s))}</span>`)
        .join('');
      const canRevoke = state.key === 'active';
      const owner = scope === 'all'
        ? `<span class="api-token-owner">${escapeHtml(token.ownerNick || token.ownerUsername || '未知用户')}</span>`
        : '';

      return `
        <article class="api-token-row" data-token-id="${token.id}">
          <div class="api-token-main">
            <div class="api-token-title">
              <strong>${escapeHtml(token.name)}</strong>
              <span class="api-token-state is-${state.key}">${state.label}</span>
              ${owner}
            </div>
            <code class="api-token-prefix">${escapeHtml(token.prefix)}…</code>
            <div class="api-scope-chips">${scopes || '<span class="api-scope-chip">无权限</span>'}</div>
            <p class="api-token-meta">
              创建 ${formatDate(token.createdAt)} · 最后使用 ${formatDate(token.lastUsedAt)}
              · 到期 ${formatDate(token.expiresAt)} · 调用 ${token.callCount ?? 0} 次
            </p>
          </div>
          <div class="api-token-actions">
            ${canRevoke ? `<button class="danger-btn small" type="button" data-revoke="${token.id}">吊销</button>` : ''}
            <button class="plain-btn small" type="button" data-remove="${token.id}">彻底删除</button>
          </div>
        </article>
      `;
    })
    .join('');
}

async function loadTokens(scope = 'self') {
  if (!apiTokenList) return;
  apiTokenList.innerHTML = '<div class="api-token-empty">正在加载令牌…</div>';
  try {
    const payload = await api(`/api/api-center/tokens?scope=${encodeURIComponent(scope)}`);
    renderTokenList(payload.tokens || [], scope);
  } catch (error) {
    apiTokenList.innerHTML = `<div class="api-token-empty is-error">加载失败：${escapeHtml(error.message)}</div>`;
  }
}

async function loadLogs(scope = 'self') {
  if (!apiLogBody) return;
  try {
    const payload = await api(`/api/api-center/logs?scope=${encodeURIComponent(scope)}&limit=50`);
    const logs = payload.logs || [];
    if (apiLogHint) apiLogHint.textContent = `${logs.length} 条`;

    if (logs.length === 0) {
      apiLogBody.innerHTML = '<tr><td colspan="7" class="muted">暂无调用记录。</td></tr>';
      return;
    }

    apiLogBody.innerHTML = logs
      .map((log) => {
        const cls = log.statusCode >= 400 ? 'is-bad' : 'is-ok';
        const ownerCell = scope === 'all'
          ? `<td>${escapeHtml(log.ownerNick || log.ownerUsername || '—')}</td>`
          : '';
        const moduleLabel = (catalog.modules || []).find((m) => m.key === log.module)?.label || log.module || '—';
        return `
          <tr>
            <td class="muted">${escapeHtml(formatDate(log.createdAt))}</td>
            ${ownerCell}
            <td>${escapeHtml(log.tokenName)}</td>
            <td>${escapeHtml(moduleLabel)}</td>
            <td><code>${escapeHtml(log.method)}</code></td>
            <td><code class="api-log-path">${escapeHtml(log.path)}</code></td>
            <td><span class="api-log-status ${cls}">${log.statusCode}</span></td>
          </tr>
        `;
      })
      .join('');
  } catch (error) {
    apiLogBody.innerHTML = `<tr><td colspan="7" class="muted">日志加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function bootstrap() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    window.location.href = '/login.html';
    return;
  }
  if (!user) return;

  if (userName) userName.textContent = user.nick || user.username || '-';
  try { setWorkspaceUser(user); } catch { /* 忽略 */ }

  // 权限目录
  try {
    const payload = await api('/api/api-center/catalog');
    catalog = payload;
    isAdmin = Boolean(payload.isAdmin);
  } catch {
    catalog = { isAdmin: false, modules: [], selfServiceScopes: [] };
  }

  // 管理员专属 UI
  document.querySelectorAll('.admin-only, .admin-only-col').forEach((el) => {
    if (isAdmin) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });

  renderPermissionTree();

  // 管理员：加载用户下拉，用于代建令牌
  if (isAdmin && apiTokenOwnerInput) {
    try {
      const payload = await api('/api/admin/overview');
      const users = payload.users || [];
      apiTokenOwnerInput.innerHTML = '<option value="">我自己</option>' +
        users.map((u) => `<option value="${u.id}">${escapeHtml(u.nick || u.username)}</option>`).join('');
    } catch { /* 拿不到就只建自己的 */ }
  }

  if (isAdmin && statsScopeSwitch) statsScopeSwitch.classList.remove('hidden');
  if (isAdmin && tokenScopeSwitch) tokenScopeSwitch.classList.remove('hidden');

  bindScopeSwitch(statsScopeSwitch, (scope) => loadStats(scope));
  bindScopeSwitch(tokenScopeSwitch, (scope) => { loadTokens(scope); loadLogs(scope); });

  await Promise.all([loadStats('self'), loadTokens('self'), loadLogs('self')]);
}

if (logoutBtn) logoutBtn.addEventListener('click', logout);

// 创建令牌
if (apiTokenForm) {
  apiTokenForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = String(apiTokenNameInput?.value || '').trim();
    const scopes = [...apiPermissionTree.querySelectorAll('input[name="apiScope"]:checked')].map((i) => i.value);
    const expiresInDays = Number(apiTokenExpiryInput?.value || 0);
    const userId = apiTokenOwnerInput?.value || '';

    if (!name) {
      if (apiTokenFormStatus) apiTokenFormStatus.textContent = '请填写令牌名称。';
      return;
    }
    if (scopes.length === 0) {
      if (apiTokenFormStatus) apiTokenFormStatus.textContent = '请至少勾选一项权限。';
      return;
    }

    if (createApiTokenBtn) createApiTokenBtn.disabled = true;
    if (apiTokenFormStatus) apiTokenFormStatus.textContent = '正在创建…';

    try {
      const payload = await api('/api/api-center/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name,
          scopes,
          expiresInDays: expiresInDays > 0 ? expiresInDays : undefined,
          userId: userId || undefined
        })
      });

      // 明文保存在页面变量里，支持反复复制
      currentRevealToken = payload.token || '';
      if (apiTokenRevealValue) apiTokenRevealValue.textContent = currentRevealToken;
      if (apiTokenReveal) apiTokenReveal.hidden = false;
      if (copyApiTokenStatus) copyApiTokenStatus.textContent = '';

      apiTokenForm.reset();
      renderPermissionTree();

      showToast('令牌创建成功，请及时复制保存', 'success');
      await Promise.all([loadTokens(tokenScopeSwitch?.querySelector('.scope-btn.active')?.dataset.scope || 'self'), loadStats('self')]);
    } catch (error) {
      if (apiTokenFormStatus) apiTokenFormStatus.textContent = `创建失败：${error.message}`;
    } finally {
      if (createApiTokenBtn) createApiTokenBtn.disabled = false;
    }
  });
}

// 复制令牌
if (copyApiTokenBtn) {
  copyApiTokenBtn.addEventListener('click', async () => {
    if (!currentRevealToken && apiTokenRevealValue) {
      currentRevealToken = apiTokenRevealValue.textContent || '';
    }
    const ok = await copyText(currentRevealToken);
    if (ok) {
      if (copyApiTokenStatus) copyApiTokenStatus.textContent = '已复制到剪贴板 ✓';
      showToast('令牌已复制', 'success');
    } else {
      selectElementText(apiTokenRevealValue);
      if (copyApiTokenStatus) copyApiTokenStatus.textContent = '浏览器阻止了自动复制，已选中内容，请按 Ctrl/Cmd + C';
      showToast('请按 Ctrl/Cmd + C 手动复制', 'info');
    }
  });
}

if (apiTokenRevealCloseBtn) {
  apiTokenRevealCloseBtn.addEventListener('click', () => {
    if (apiTokenReveal) apiTokenReveal.hidden = true;
    currentRevealToken = '';
    if (apiTokenRevealValue) apiTokenRevealValue.textContent = '';
    if (copyApiTokenStatus) copyApiTokenStatus.textContent = '';
  });
}

// 吊销 / 删除
if (apiTokenList) {
  apiTokenList.addEventListener('click', async (event) => {
    const currentScope = tokenScopeSwitch?.querySelector('.scope-btn.active')?.dataset.scope || 'self';
    const revokeBtn = event.target.closest('[data-revoke]');
    const removeBtn = event.target.closest('[data-remove]');

    if (revokeBtn) {
      if (!window.confirm('吊销后使用该令牌的外部系统会立即失效，确定继续？')) return;
      revokeBtn.disabled = true;
      try {
        await api(`/api/api-center/tokens/${revokeBtn.getAttribute('data-revoke')}`, { method: 'DELETE', body: '{}' });
        showToast('令牌已吊销', 'success');
        await Promise.all([loadTokens(currentScope), loadStats('self')]);
      } catch (error) {
        showToast(`吊销失败：${error.message}`, 'error');
        revokeBtn.disabled = false;
      }
      return;
    }

    if (removeBtn) {
      if (!window.confirm('彻底删除后不可恢复，确定继续？')) return;
      removeBtn.disabled = true;
      try {
        await api(`/api/api-center/tokens/${removeBtn.getAttribute('data-remove')}/permanent`, { method: 'DELETE', body: '{}' });
        showToast('令牌已删除', 'success');
        await Promise.all([loadTokens(currentScope), loadStats('self')]);
      } catch (error) {
        showToast(`删除失败：${error.message}`, 'error');
        removeBtn.disabled = false;
      }
    }
  });
}

bootstrap();
