import { setWorkspaceUser } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';
import { API_BASE_URL } from '../config.js';
import { money, totalCents, filterEntries } from '../ledger-utils.js';
import { showToast, closeDialogAnimated } from '../ui-feedback.js';

const $ = id => document.getElementById(id);
const form = $('entryForm');
const dialog = $('editDialog');
const endpoint = '/api/admin/costs';
// 单值筛选字段；项目 / 类别走多选（见 selections），不在这里
const singleFilterKeys = ['search', 'month', 'paymentStatus'];
// 项目 / 类别多选：集合为空 = 不筛（即「全部」）
const selections = { project: new Set(), category: new Set() };
const fields = ['date', 'project', 'category', 'amount', 'paymentStatus', 'handler', 'description', 'notes'];
// 项目管理里登记的项目（来源 /api/admin/projects），用于新增成本弹窗的下拉。
let projectRegistry = [];
let entries = [];
let user = null;
let editing = null;
let saving = false;
let conflicted = false;
let loading = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text ?? '');
  if (className) element.className = className;
  return element;
}
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('ledger-error', error);
}
function handleAuth(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  user = null;
  entries = [];
  $('rows').replaceChildren();
  $('ledgerWorkspace').hidden = true;
  if (dialog.open) closeDialogAnimated(dialog);
  if (error.code === 'PASSWORD_CHANGE_REQUIRED') window.location.href = '/change-password.html';
  else if (error.status === 401) redirectToLogin('登录已失效，请重新登录。');
  else status('当前账号没有管理员台账权限。', true);
  return true;
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sorted(list) {
  const [key, direction] = $('sort').value.split('-');
  return [...list].sort((a, b) => {
    let result;
    if (key === 'amount') result = compare(BigInt(a.amountCents), BigInt(b.amountCents));
    else result = String(a[key]).localeCompare(String(b[key]), 'zh-CN');
    return (direction === 'desc' ? -result : result) || -compare(BigInt(a.id), BigInt(b.id));
  });
}
function paymentLabel(value) { return value === 'paid' ? '已付款' : '待付款'; }
// ---------- 凭证展示：列表里直接出图（不再只是一个下载按钮），点开看大图 ----------
// 附件接口带 Content-Disposition: attachment，直接塞进 <img src> 不可靠，
// 所以统一 fetch 成 blob 再用 object URL 渲染，顺便保住原来的下载/鉴权逻辑。
const voucherUrls = new Map();     // attachmentId -> blob URL
const voucherEntries = new Map();  // attachmentId -> entry
let voucherEntry = null;
function isImageVoucher(entry) { return /\.(png|jpe?g)$/i.test(entry.attachmentName || ''); }
async function fetchVoucherUrl(entry) {
  const cached = voucherUrls.get(entry.attachmentId);
  if (cached) return cached;
  const response = await fetch(`${API_BASE_URL}${endpoint}/attachments/${encodeURIComponent(entry.attachmentId)}`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw Object.assign(new Error(payload.message || '凭证加载失败'), { status: response.status, code: payload.code });
  }
  const url = URL.createObjectURL(await response.blob());
  voucherUrls.set(entry.attachmentId, url);
  return url;
}
async function paintThumb(button) {
  const entry = voucherEntries.get(button.dataset.attachmentId);
  if (!entry) return;
  try {
    const url = await fetchVoucherUrl(entry);
    const image = node('img');
    image.src = url;
    image.alt = `凭证：${entry.project || entry.date}`;
    image.loading = 'lazy';
    button.classList.remove('is-loading');
    button.replaceChildren(image);
  } catch (error) {
    button.classList.remove('is-loading');
    button.textContent = '加载失败';
    if (!handleAuth(error)) status(`凭证加载失败：${error.message}`, true);
  }
}
// 84 张凭证一次性全拉会打爆流量，所以滚到可视区域才加载缩略图。
const thumbObserver = ('IntersectionObserver' in window && document.querySelector('.ledger-table-scroll'))
  ? new IntersectionObserver(records => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        thumbObserver.unobserve(record.target);
        paintThumb(record.target);
      }
    }, { root: document.querySelector('.ledger-table-scroll'), rootMargin: '240px' })
  : null;
function voucherCell(entry) {
  const wrap = node('div', undefined, 'ledger-voucher');
  if (!entry.attachmentId) { wrap.textContent = '—'; return wrap; }
  voucherEntries.set(entry.attachmentId, entry);
  const button = node('button', undefined, 'ledger-voucher-thumb');
  button.type = 'button';
  button.dataset.attachmentId = entry.attachmentId;
  button.setAttribute('aria-label', `查看凭证：${entry.attachmentName || entry.project || entry.date}`);
  button.addEventListener('click', () => openVoucher(entry));
  if (isImageVoucher(entry)) {
    button.classList.add('is-loading');
    if (thumbObserver) thumbObserver.observe(button);
    else paintThumb(button);
  } else {
    button.classList.add('is-pending');
    button.textContent = 'PDF';
  }
  wrap.append(button, node('span', entry.attachmentName || '凭证', 'ledger-voucher-name'));
  return wrap;
}
async function openVoucher(entry) {
  if (!user) return;
  voucherEntry = entry;
  const viewer = $('voucherDialog');
  const image = $('voucherImage');
  $('voucherTitle').textContent = isImageVoucher(entry) ? '凭证' : 'PDF 凭证';
  $('voucherMeta').textContent = `${entry.date} · ${entry.project || '—'} · ¥${money(entry.amountCents)} · ${entry.attachmentName || ''}`;
  image.removeAttribute('src');
  image.hidden = true;
  viewer.showModal();
  if (!isImageVoucher(entry)) {
    $('voucherMeta').textContent += '（PDF 无法直接预览，请点「下载凭证」查看）';
    return;
  }
  try {
    image.src = await fetchVoucherUrl(entry);
    image.alt = `凭证：${entry.project || entry.date}`;
    image.hidden = false;
  } catch (error) {
    if (handleAuth(error)) return;
    $('voucherMeta').textContent = `凭证加载失败：${error.message}`;
  }
}
function entryRow(entry) {
  const row = node('tr');
  for (const key of ['date', 'project', 'category', 'description']) row.append(node('td', entry[key] || '—'));
  row.append(node('td', money(entry.amountCents), 'ledger-money'));
  const payment = node('td');
  payment.append(node('span', paymentLabel(entry.paymentStatus), `ledger-badge ledger-${entry.paymentStatus === 'paid' ? 'paid' : 'unpaid'}`));
  row.append(payment, node('td', entry.handler), node('td', entry.notes || '—'));
  const attachment = node('td');
  attachment.append(voucherCell(entry));
  row.append(attachment);
  for (const prefix of ['created', 'updated']) {
    const cell = node('td', entry[`${prefix}ByName`] || entry[`${prefix}By`] || '—');
    cell.append(node('small', entry[`${prefix}At`] || '—', 'ledger-audit'));
    row.append(cell);
  }
  const action = node('td');
  const button = node('button', '编辑');
  button.type = 'button';
  button.setAttribute('aria-label', `编辑 ${entry.date} ${entry.project}`);
  button.addEventListener('click', async () => {
    await loadProjectSuggestions();
    openEditor(entry);
  });
  action.append(button);
  row.append(action);
  return row;
}
// 当前筛选条件：项目 / 类别是多选数组，空数组即「全部」
function currentFilters() {
  return {
    search: $('search').value,
    month: $('month').value,
    paymentStatus: $('paymentStatus').value,
    project: [...selections.project],
    category: [...selections.category]
  };
}
function renderInsights(visible) {
  const total = totalCents(visible);
  const paid = totalCents(visible.filter(entry => entry.paymentStatus === 'paid'));
  const percent = total > 0n ? Number(paid * 1000n / total) / 10 : 0;
  $('paymentProgress').value = percent;
  $('paymentProgressLabel').textContent = visible.length ? `${percent}% 已付款` : '暂无支出记录';
  $('paymentProgressHint').textContent = visible.length ? `已付 ¥${money(paid)} · 待付 ¥${money(total - paid)}` : '新增成本或调整筛选条件，查看付款进度。';
  // 两个分布各自「先排除自己这一维」再统计：点掉某个类别后，其它类别仍留在榜上，
  // 才能继续多选。否则一点就只剩一项，多选无从下手。
  const filters = currentFilters();
  renderBreakdown('categoryBreakdown', filterEntries(entries, { ...filters, category: [] }), 'category', '尚无分类支出，新增记录后将自动汇总。');
  renderBreakdown('projectBreakdown', filterEntries(entries, { ...filters, project: [] }), 'project', '尚无项目支出，新增记录后将自动汇总。');
}
// 「支出分类」和「项目分布」共用一个渲染器，两个维度口径完全一致。
function renderBreakdown(targetId, visible, key, emptyText) {
  const totals = new Map();
  const counts = new Map();
  for (const entry of visible) {
    const name = entry[key] || '未填写';
    totals.set(name, (totals.get(name) || 0n) + BigInt(entry.amountCents));
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const total = totalCents(visible);
  const ranked = [...totals].sort((a, b) => compare(b[1], a[1])).slice(0, 5);
  const list = $(targetId);
  list.replaceChildren();
  if (!ranked.length) { list.append(node('p', emptyText, 'insight-empty')); return; }
  for (const [name, amount] of ranked) {
    const active = selections[key].has(name);
    const bar = node('button', undefined, 'category-bar');
    bar.type = 'button';
    bar.dataset.value = name;
    bar.classList.toggle('is-selected', active);
    bar.setAttribute('aria-pressed', String(active));
    bar.setAttribute('aria-label', `${active ? '取消筛选' : '筛选'}${MULTI_NOUNS[key]}「${name}」，共 ${counts.get(name)} 笔 ¥${money(amount)}`);
    bar.append(node('span', name), node('strong', `¥${money(amount)}`), node('em', `${counts.get(name)} 笔`));
    const progress = node('progress');
    progress.max = 100;
    progress.value = total > 0n ? Number(amount * 1000n / total) / 10 : 0;
    progress.setAttribute('aria-hidden', 'true');
    bar.append(progress);
    bar.addEventListener('click', () => toggleSelection(key, name));
    list.append(bar);
  }
}
// ---------- 项目 / 类别 多选筛选 ----------
// 点概览里的条 = 切换该维度的筛选；集合为空表示不筛（全部）。也可以从下拉里勾。
const MULTI_NOUNS = { project: '项目', category: '类别' };
function multiInputs(key) {
  const inputs = [];
  for (const child of $(`${key}Options`).children || []) {
    const input = child.children && child.children[0];
    if (input && input.tagName === 'INPUT') inputs.push(input);
  }
  return inputs;
}
function toggleSelection(key, value) {
  if (selections[key].has(value)) selections[key].delete(value);
  else selections[key].add(value);
  render();
}
function selectAllIn(key) { for (const input of multiInputs(key)) selections[key].add(input.value); render(); }
function clearSelection(key) { selections[key].clear(); render(); }
function clearAllSelections() { selections.project.clear(); selections.category.clear(); render(); }
function syncMultiLabels() {
  for (const key of ['project', 'category']) {
    const selected = [...selections[key]];
    const toggle = $(`${key}Toggle`);
    toggle.textContent = !selected.length ? `全部${MULTI_NOUNS[key]}`
      : selected.length === 1 ? selected[0]
      : `${MULTI_NOUNS[key]}：已选 ${selected.length} 项`;
    toggle.classList.toggle('is-active', selected.length > 0);
    toggle.setAttribute('aria-expanded', String(!$(`${key}Panel`).hidden));
  }
}
// 勾选框 / 按钮文案 / chips 三者都从 selections 派生，避免各处状态漂移
function syncMultiState() {
  for (const key of ['project', 'category']) {
    for (const input of multiInputs(key)) input.checked = selections[key].has(input.value);
  }
  syncMultiLabels();
  renderActiveFilters();
}
function renderActiveFilters() {
  const wrap = $('activeFilters');
  const chips = [];
  for (const key of ['project', 'category']) {
    for (const value of [...selections[key]].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      const chip = node('span', undefined, 'ledger-chip');
      chip.append(node('span', `${MULTI_NOUNS[key]}：${value}`));
      const remove = node('button', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除筛选 ${MULTI_NOUNS[key]}：${value}`);
      remove.addEventListener('click', () => { selections[key].delete(value); render(); });
      chip.append(remove);
      chips.push(chip);
    }
  }
  wrap.replaceChildren();
  if (!chips.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const clear = node('button', '清空全部', 'ledger-clear-all');
  clear.type = 'button';
  clear.addEventListener('click', clearAllSelections);
  wrap.append(node('span', `已选 ${chips.length} 项筛选：`), ...chips, clear);
}
function toggleMultiPanel(key, force) {
  const panel = $(`${key}Panel`);
  const open = force === undefined ? panel.hidden : force;
  for (const other of ['project', 'category']) if (other !== key) $(`${other}Panel`).hidden = true;
  panel.hidden = !open;
  syncMultiLabels();
}
function closeMultiPanels() {
  for (const key of ['project', 'category']) $(`${key}Panel`).hidden = true;
  syncMultiLabels();
}
function render() {
  const visible = sorted(filterEntries(entries, currentFilters()));
  renderInsights(visible);
  syncMultiState();
  $('resultCount').textContent = `显示 ${visible.length} / ${entries.length} 笔 · 筛选合计 ¥${money(totalCents(visible))}`;
  const fragment = document.createDocumentFragment();
  const groupKey = $('group').value;
  const groups = new Map();
  for (const entry of visible) {
    const key = groupKey === 'month' ? entry.date.slice(0, 7) : groupKey === 'paymentStatus' ? paymentLabel(entry.paymentStatus) : groupKey ? entry[groupKey] : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const [label, group] of groups) {
    if (groupKey) {
      const row = node('tr', undefined, 'ledger-group');
      const cell = node('th', `${label} · ${group.length} 笔 · ¥${money(totalCents(group))}`);
      cell.colSpan = 12;
      cell.scope = 'rowgroup';
      row.append(cell);
      fragment.append(row);
    }
    for (const entry of group) fragment.append(entryRow(entry));
  }
  if (!visible.length) {
    const row = node('tr');
    const cell = node('td', undefined, 'ledger-empty');
    const title = entries.length ? '没有符合筛选条件的记录' : '还没有成本记录';
    const hint = entries.length ? '调整条件，或重置筛选查看全部记录。' : '从新增一笔支出开始，所有管理员都会看到同一份台账。';
    const icon = node('span', '↗', 'ledger-empty-icon');
    icon.setAttribute('aria-hidden', 'true');
    cell.colSpan = 12;
    cell.append(icon, node('strong', title), node('span', hint));
    row.append(cell);
  }
  $('rows').replaceChildren(fragment);
}
// 项目 / 类别的多选列表。选项来自台账里已出现的值；已被选中的值即使当前结果集里没有
// 也保留，避免筛选条件被悄悄清掉。
function refreshOptions() {
  for (const key of ['project', 'category']) {
    const values = [...new Set(entries.map(entry => entry[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const selected of selections[key]) if (!values.includes(selected)) values.push(selected);
    const list = $(`${key}Options`);
    list.replaceChildren();
    if (!values.length) { list.append(node('p', '暂无可选项', 'insight-empty')); continue; }
    for (const value of values) {
      const option = node('label', undefined, 'ledger-multi-option');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = value;
      box.checked = selections[key].has(value);
      // 以勾选框自身状态为准，避免和 selections 漂移
      box.addEventListener('change', () => {
        if (box.checked) selections[key].add(value);
        else selections[key].delete(value);
        render();
      });
      option.append(box, node('span', value));
      list.append(option);
    }
  }
  // 新增/编辑弹窗的类别下拉与此同源，避免「下面的筛选有、上面录入时反而没有」。
  categoryRegistry = [...new Set(entries.map(entry => entry.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  syncMultiState();
}
async function loadEntries() {
  if (!user || loading) return false;
  loading = true;
  $('refreshBtn').disabled = true;
  status('正在加载台账…');
  try {
    const payload = await api(endpoint);
    entries = payload.entries;
    $('total').textContent = money(totalCents(entries));
    $('monthTotal').textContent = money(totalCents(entries.filter(entry => entry.date.startsWith(payload.month))));
    $('unpaid').textContent = money(totalCents(entries.filter(entry => entry.paymentStatus === 'unpaid')));
    $('summaryMonth').textContent = `${payload.month} · 元`;
    refreshOptions();
    render();
    // Cleared rather than restating "所有管理员共享记录" — that's already in
    // the page's own subtitle right above; a status line only needs to speak
    // up for loading/errors, not repeat what's already on screen.
    status('');
    return true;
  } catch (error) {
    if (!handleAuth(error)) status(`加载失败：${error.message}。可点击刷新重试；现有数据可能已过期。`, true);
    return false;
  } finally {
    loading = false;
    $('refreshBtn').disabled = false;
  }
}
function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// 项目字段是三段式：下拉（已登记项目）+「其他（手填）」+ 手填输入框。
// 台账里可能存在没在项目管理里登记过的历史项目名，所以不能强制只能从下拉选。
const CUSTOM_PROJECT = '__custom__';
function currentProjectValue() {
  const select = $('entryProjectSelect');
  if (select.value === CUSTOM_PROJECT) return $('entryProjectCustom').value;
  return select.value;
}
function syncCustomProjectVisibility() {
  const custom = $('entryProjectSelect').value === CUSTOM_PROJECT;
  const input = $('entryProjectCustom');
  input.hidden = !custom;
  input.required = custom;
  if (!custom) input.value = '';
}
// 把管理中枢「项目管理」登记的项目名填进新增/编辑弹窗的下拉。
// 同时合并台账里已有的项目名，避免历史未登记项目在编辑时丢失。
function fillEntryProjectOptions(projects, selected = '') {
  const select = $('entryProjectSelect');
  const names = projects.map(project => project.name);
  if (selected && !names.includes(selected)) names.push(selected);
  const placeholder = node('option', names.length ? '请选择项目' : '暂无已登记项目，请选「其他」手填');
  placeholder.value = '';
  placeholder.disabled = true;
  select.replaceChildren(placeholder);
  for (const name of names) {
    const option = node('option', name);
    option.value = name;
    select.append(option);
  }
  const custom = node('option', '其他（手填项目名）');
  custom.value = CUSTOM_PROJECT;
  select.append(custom);
  if (selected && names.includes(selected)) {
    select.value = selected;
  } else {
    select.value = selected ? CUSTOM_PROJECT : '';
    if (selected) $('entryProjectCustom').value = selected;
  }
  syncCustomProjectVisibility();
}
// 类别字段同样改成三段式（下拉 +「其他」手填 + 提示）。
// 原来只是自由文本挂 datalist，跟项目字段当初一样「点开什么都看不见」，所以统一成下拉，
// 选项来自台账里已出现过的全部类别（和下方筛选栏的类别下拉同源，保证两边一致）。
const CUSTOM_CATEGORY = '__custom__';
let categoryRegistry = [];
function currentCategoryValue() {
  const select = $('entryCategorySelect');
  if (select.value === CUSTOM_CATEGORY) return $('entryCategoryCustom').value;
  return select.value;
}
function syncCustomCategoryVisibility() {
  const custom = $('entryCategorySelect').value === CUSTOM_CATEGORY;
  const input = $('entryCategoryCustom');
  input.hidden = !custom;
  input.required = custom;
  if (!custom) input.value = '';
}
function fillEntryCategoryOptions(selected = '') {
  const select = $('entryCategorySelect');
  const names = [...categoryRegistry];
  if (selected && !names.includes(selected)) names.push(selected);
  names.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const placeholder = node('option', names.length ? '请选择类别' : '暂无类别，请选「其他」手填');
  placeholder.value = '';
  placeholder.disabled = true;
  select.replaceChildren(placeholder);
  for (const name of names) {
    const option = node('option', name);
    option.value = name;
    select.append(option);
  }
  const custom = node('option', '其他（手填类别）');
  custom.value = CUSTOM_CATEGORY;
  select.append(custom);
  if (selected && names.includes(selected)) {
    select.value = selected;
  } else {
    select.value = selected ? CUSTOM_CATEGORY : '';
    if (selected) $('entryCategoryCustom').value = selected;
  }
  syncCustomCategoryVisibility();
  $('categoryFieldHint').textContent = categoryRegistry.length
    ? `已带出台账里的 ${categoryRegistry.length} 个类别：${categoryRegistry.slice(0, 8).join('、')}${categoryRegistry.length > 8 ? ' 等' : ''}。`
    : '台账里还没有类别，可先选「其他（手填类别）」。';
}
function openEditor(entry = null) {
  if (!user || saving) return;
  editing = entry;
  conflicted = false;
  form.reset();
  for (const field of fields) {
    if (field === 'project') continue; // 项目字段走下拉 + 手填，单独处理
    form.elements.namedItem(field).value = entry ? (field === 'amount' ? money(entry.amountCents) : entry[field] || '') : '';
  }
  fillEntryProjectOptions(projectRegistry, entry ? entry.project || '' : '');
  fillEntryCategoryOptions(entry ? entry.category || '' : '');
  if (!entry) {
    form.elements.namedItem('date').value = localDate();
    form.elements.namedItem('paymentStatus').value = 'unpaid';
    form.elements.namedItem('handler').value = user.nick || user.username || '';
  }
  $('dialogTitle').textContent = entry ? '编辑成本' : '新增成本';
  clearAttachment();
  $('formStatus').textContent = '';
  $('saveBtn').disabled = false;
  dialog.showModal();
  form.elements.namedItem('date').focus();
}
// ---------- 凭证：文件选择 / 拖拽 / 剪贴板粘贴（Ctrl+V 贴截图） ----------
const ATTACHMENT_LIMIT = 3 * 1024 * 1024;
// 当前待上传的凭证，来源可能是文件选择、拖拽或粘贴；null 表示本次不修改凭证。
let selectedAttachment = null;
let attachmentPreviewUrl = '';
const attachmentZone = $('attachmentZone');
const attachmentInput = $('entryAttachment');
const attachmentIdle = $('attachmentIdle');
const attachmentPreview = $('attachmentPreview');
const attachmentPreviewImg = $('attachmentPreviewImg');
const attachmentClearBtn = $('attachmentClearBtn');
function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
// 部分老浏览器没有 File 构造器，退化成带 name 的 Blob。
function namedFile(blob, name, type) {
  try { return new File([blob], name, { type }); } catch {
    const copy = blob.slice(0, blob.size, type);
    Object.defineProperty(copy, 'name', { value: name });
    return copy;
  }
}
// 按魔数识别真实格式，返回 'png' | 'jpg' | 'pdf'，不认识返回 ''。
async function sniffFormat(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const starts = signature => signature.every((byte, index) => head[index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (starts([255, 216, 255])) return 'jpg';
  if (starts([37, 80, 68, 70, 45])) return 'pdf';
  return '';
}
function attachmentHintText() {
  if (selectedAttachment) {
    const replacing = editing && editing.attachmentId ? '保存后将替换原凭证' : '保存后随记录一并提交';
    return `待上传凭证：${selectedAttachment.name}（${formatBytes(selectedAttachment.size)}），${replacing}。`;
  }
  if (editing && editing.attachmentId) return `当前凭证：${editing.attachmentName}。不选择文件将保留原凭证；粘贴截图或选择新文件将替换。`;
  return '可选；仅支持 PDF / PNG / JPEG，最大 3 MiB。可直接 Ctrl / ⌘ + V 粘贴截图。';
}
function refreshAttachmentView() {
  const ready = Boolean(selectedAttachment);
  attachmentIdle.hidden = ready;
  attachmentPreview.hidden = !ready;
  attachmentClearBtn.hidden = !ready;
  if (attachmentPreviewUrl) { URL.revokeObjectURL(attachmentPreviewUrl); attachmentPreviewUrl = ''; }
  attachmentPreviewImg.removeAttribute('src');
  attachmentPreviewImg.hidden = true;
  if (ready) {
    $('attachmentName').textContent = selectedAttachment.name;
    $('attachmentSize').textContent = formatBytes(selectedAttachment.size);
    if (/^image\//i.test(selectedAttachment.type)) {
      attachmentPreviewUrl = URL.createObjectURL(selectedAttachment);
      attachmentPreviewImg.src = attachmentPreviewUrl;
      attachmentPreviewImg.hidden = false;
    }
  }
  $('attachmentHint').textContent = attachmentHintText();
}
function clearAttachment() {
  selectedAttachment = null;
  attachmentInput.value = '';
  refreshAttachmentView();
}
// 校验 → 按实际内容统一命名 → 预览。renameByContent 用于粘贴/拖拽（文件名不可信，常为 image.png）。
async function acceptAttachment(file, renameByContent) {
  try {
    if (!file || !file.size) throw new Error('凭证不能为空。');
    if (file.size > ATTACHMENT_LIMIT) throw new Error('凭证不能超过 3 MiB。');
    const ext = await sniffFormat(file);
    if (!ext) throw new Error('仅接受 PDF / PNG / JPEG，当前内容不是这三种格式。');
    const expected = ext === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${ext}$`, 'i');
    selectedAttachment = (renameByContent || !expected.test(String(file.name || '')))
      ? namedFile(file, `凭证-${timestamp()}.${ext}`, ext === 'pdf' ? 'application/pdf' : ext === 'jpg' ? 'image/jpeg' : 'image/png')
      : file;
    refreshAttachmentView();
    $('formStatus').textContent = '';
    return true;
  } catch (error) {
    $('formStatus').textContent = `凭证未能载入：${error.message}`;
    return false;
  }
}
// 从粘贴/拖拽数据里挑第一个受支持的凭证文件。
function pickClipboardFile(data) {
  const direct = [...(data.files || [])];
  const items = [...(data.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  const all = direct.length ? direct : items;
  return { all, usable: all.find(candidate => /^(image\/(png|jpe?g)|application\/pdf)$/i.test(candidate.type || '')) };
}
async function encodeAttachment(file) {
  if (!file.size || file.size > 3 * 1024 * 1024) throw new Error('凭证不能为空且不能超过 3 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const starts = signature => signature.every((byte, i) => bytes[i] === byte);
  const valid = (/\.pdf$/i.test(file.name) && starts([37, 80, 68, 70, 45])) ||
    (/\.png$/i.test(file.name) && starts([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (/\.jpe?g$/i.test(file.name) && starts([255, 216, 255]));
  if (!valid) throw new Error('凭证必须为 PDF / PNG / JPEG，且文件扩展名与内容一致。');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { name: file.name, data: btoa(binary) };
}
async function saveEntry(event) {
  event.preventDefault();
  if (!user || saving || conflicted || !form.reportValidity()) return;
  const payload = Object.fromEntries(fields.map(field => [field, form.elements.namedItem(field).value]));
  payload.project = currentProjectValue().trim();
  payload.category = currentCategoryValue().trim();
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(payload.amount) || /^0(?:\.0{1,2})?$/.test(payload.amount)) {
    $('formStatus').textContent = '金额须大于零、最多两位小数，且不超过 999999999.99。';
    return;
  }
  if (['project', 'category', 'handler'].some(key => !payload[key].trim())) {
    $('formStatus').textContent = '项目、类别和经办人不能为空。';
    return;
  }
  if (editing) payload.version = editing.version;
  const file = selectedAttachment;
  saving = true;
  $('saveBtn').disabled = true;
  $('cancelBtn').disabled = true;
  $('formStatus').textContent = '正在保存，请勿关闭页面…';
  let saved = false;
  try {
    if (file) payload.attachment = await encodeAttachment(file);
    await api(editing ? `${endpoint}/${encodeURIComponent(editing.id)}` : endpoint, {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    saved = true;
    closeDialogAnimated(dialog);
    const refreshed = await loadEntries();
    if (refreshed) {
      showToast('已保存', $('saveBtn'));
    } else if (user) status('保存已成功，但列表刷新失败。请刷新列表，勿重复新增。', true);
  } catch (error) {
    if (handleAuth(error)) return;
    if (error.status === 409) {
      conflicted = true;
      $('formStatus').textContent = '该记录已被其他管理员修改（409）。为防止覆盖，已停止保存。请保留需要的内容，取消后刷新列表，再重新编辑。';
    } else $('formStatus').textContent = error.status ? `保存失败：${error.message}` : `未能确认保存结果：${error.message}。请先取消并刷新列表核对，避免重复新增。`;
  } finally {
    saving = false;
    $('saveBtn').disabled = conflicted || saved;
    $('cancelBtn').disabled = false;
  }
}
async function downloadAttachment(entry, button) {
  if (!user) return;
  button.disabled = true;
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}/attachments/${encodeURIComponent(entry.attachmentId)}`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.message || '下载失败'), { status: response.status, code: payload.code });
    }
    const url = URL.createObjectURL(await response.blob());
    const link = node('a');
    link.href = url;
    link.download = entry.attachmentName || '凭证';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status('凭证已下载。');
  } catch (error) {
    if (!handleAuth(error)) status(`凭证下载失败：${error.message}`, true);
  } finally { button.disabled = false; }
}
for (const key of [...singleFilterKeys, 'sort', 'group']) $(key).addEventListener(key === 'search' ? 'input' : 'change', render);
// 多选筛选：开关面板 / 全选 / 清空 / 点到外面或按 Esc 收起
$('projectToggle').addEventListener('click', () => toggleMultiPanel('project'));
$('categoryToggle').addEventListener('click', () => toggleMultiPanel('category'));
$('projectAll').addEventListener('click', () => selectAllIn('project'));
$('categoryAll').addEventListener('click', () => selectAllIn('category'));
$('projectNone').addEventListener('click', () => clearSelection('project'));
$('categoryNone').addEventListener('click', () => clearSelection('category'));
document.addEventListener('click', event => {
  const target = event.target;
  if (target && typeof target.closest === 'function' && target.closest('.ledger-multi')) return;
  closeMultiPanels();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMultiPanels(); });
$('resetBtn').addEventListener('click', () => {
  for (const key of [...singleFilterKeys, 'group']) $(key).value = '';
  $('sort').value = 'date-desc';
  selections.project.clear();
  selections.category.clear();
  closeMultiPanels();
  render();
});
$('newBtn').addEventListener('click', async () => {
  // 打开前刷新一次项目列表：管理员刚在管理中枢登记的新项目能立刻带出。
  await loadProjectSuggestions();
  fillEntryProjectOptions(projectRegistry);
  openEditor();
});
$('entryProjectSelect').addEventListener('change', syncCustomProjectVisibility);
$('entryCategorySelect').addEventListener('change', syncCustomCategoryVisibility);
$('refreshBtn').addEventListener('click', loadEntries);
$('cancelBtn').addEventListener('click', () => { if (!saving) closeDialogAnimated(dialog); });
dialog.addEventListener('cancel', event => {
  if (saving) { event.preventDefault(); return; }
  event.preventDefault();
  closeDialogAnimated(dialog);
});
// 凭证大图弹窗
$('voucherCloseBtn').addEventListener('click', () => closeDialogAnimated($('voucherDialog')));
$('voucherDownloadBtn').addEventListener('click', event => { if (voucherEntry) downloadAttachment(voucherEntry, event.currentTarget); });
$('voucherDialog').addEventListener('cancel', event => { event.preventDefault(); closeDialogAnimated($('voucherDialog')); });
form.addEventListener('submit', saveEntry);
// 凭证录入：点击 / 按钮选文件、拖拽、以及 Ctrl+V 直接粘贴截图（微信、钉钉、截图工具均可）。
$('attachmentPickBtn').addEventListener('click', () => { if (!saving) attachmentInput.click(); });
attachmentZone.addEventListener('click', event => {
  if (saving || event.target === attachmentInput) return;
  attachmentInput.click();
});
attachmentZone.addEventListener('keydown', event => {
  if (saving) return;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); attachmentInput.click(); }
});
attachmentClearBtn.addEventListener('click', () => { if (!saving) clearAttachment(); });
attachmentInput.addEventListener('change', async () => {
  const picked = attachmentInput.files && attachmentInput.files[0];
  if (picked) await acceptAttachment(picked, false);
  else if (!selectedAttachment) clearAttachment();
});
attachmentZone.addEventListener('dragover', event => {
  if (saving) return;
  event.preventDefault();
  attachmentZone.classList.add('ledger-attach-active');
});
attachmentZone.addEventListener('dragleave', () => attachmentZone.classList.remove('ledger-attach-active'));
attachmentZone.addEventListener('drop', async event => {
  attachmentZone.classList.remove('ledger-attach-active');
  if (saving) return;
  event.preventDefault();
  const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (dropped) await acceptAttachment(dropped, true);
});
// 仅在弹窗打开时接管粘贴，且只在剪贴板里确实有凭证图片/PDF 时才 preventDefault：
// 往「说明」「备注」里粘贴纯文本、从 Excel 粘贴表格都不受影响。
document.addEventListener('paste', async event => {
  if (!dialog.open || saving || !event.clipboardData) return;
  const { all, usable } = pickClipboardFile(event.clipboardData);
  if (!all.length) return;
  event.preventDefault();
  if (!usable) {
    $('formStatus').textContent = '剪贴板里的图片不是受支持的凭证格式，请粘贴 PNG / JPEG 截图，或改用「选择文件」上传 PDF。';
    return;
  }
  await acceptAttachment(usable, true);
});
$('logoutBtn').addEventListener('click', async () => {
  try { await logout(); } catch (error) { if (!handleAuth(error)) status(`退出失败：${error.message}`, true); }
});
// "项目"栏位使用下拉选择（管理中枢"项目管理"里维护的项目名），并保留"其他（手填）"
// 以便录入历史遗留的、尚未登记的项目名。这里同时刷新弹窗下拉和列表筛选下拉。
async function loadProjectSuggestions() {
  try {
    const payload = await api('/api/admin/projects');
    projectRegistry = payload.projects || [];
    const datalist = $('projectSuggestions');
    datalist.replaceChildren(...projectRegistry.map((project) => {
      const option = document.createElement('option');
      option.value = project.name;
      return option;
    }));
    $('projectFieldHint').textContent = projectRegistry.length
      ? `已从项目管理带出 ${projectRegistry.length} 个项目；新增项目后重新打开本窗口即可看到。`
      : '项目管理里还没有登记项目，可先选「其他（手填项目名）」，或去管理中枢 → 项目管理登记。';
    return true;
  } catch {
    $('projectFieldHint').textContent = '项目列表加载失败，可选「其他（手填项目名）」继续录入。';
    // 拉取失败不影响录入成本，用户仍可以手填项目名。
    return false;
  }
}

async function init() {
  try {
    user = await requireUser();
    if (!user) return;
    if (user.role !== 'admin') {
      user = null;
      status('当前账号没有管理员台账权限。', true);
      return;
    }
    setWorkspaceUser(user);
    $('userName').textContent = user.nick || user.username || '管理员';
    $('ledgerWorkspace').hidden = false;
    await loadProjectSuggestions();
    fillEntryProjectOptions(projectRegistry);
    await loadEntries();
  } catch (error) {
    if (!handleAuth(error)) status(`身份验证失败：${error.message}。请重新加载页面。`, true);
  }
}
init();
