import { setWorkspaceUser } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';
import { API_BASE_URL } from '../config.js';
import { money, totalCents, filterEntries } from '../ledger-utils.js';
import { showToast, closeDialogAnimated } from '../ui-feedback.js';

const $ = id => document.getElementById(id);
const form = $('entryForm');
const dialog = $('editDialog');
const endpoint = '/api/admin/costs';
const filterKeys = ['search', 'month', 'project', 'category', 'paymentStatus'];
const fields = ['date', 'project', 'category', 'amount', 'paymentStatus', 'handler', 'description', 'notes'];
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
function entryRow(entry) {
  const row = node('tr');
  for (const key of ['date', 'project', 'category', 'description']) row.append(node('td', entry[key] || '—'));
  row.append(node('td', money(entry.amountCents), 'ledger-money'));
  const payment = node('td');
  payment.append(node('span', paymentLabel(entry.paymentStatus), `ledger-badge ledger-${entry.paymentStatus === 'paid' ? 'paid' : 'unpaid'}`));
  row.append(payment, node('td', entry.handler), node('td', entry.notes || '—'));
  const attachment = node('td');
  if (entry.attachmentId) {
    const button = node('button', entry.attachmentName || '下载凭证', 'ledger-link');
    button.type = 'button';
    button.addEventListener('click', () => downloadAttachment(entry, button));
    attachment.append(button);
  } else attachment.textContent = '—';
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
  button.addEventListener('click', () => openEditor(entry));
  action.append(button);
  row.append(action);
  return row;
}
function renderInsights(visible) {
  const total = totalCents(visible);
  const paid = totalCents(visible.filter(entry => entry.paymentStatus === 'paid'));
  const percent = total > 0n ? Number(paid * 1000n / total) / 10 : 0;
  $('paymentProgress').value = percent;
  $('paymentProgressLabel').textContent = visible.length ? `${percent}% 已付款` : '暂无支出记录';
  $('paymentProgressHint').textContent = visible.length ? `已付 ¥${money(paid)} · 待付 ¥${money(total - paid)}` : '新增成本或调整筛选条件，查看付款进度。';
  const amounts = new Map();
  visible.forEach(entry => amounts.set(entry.category, (amounts.get(entry.category) || 0n) + BigInt(entry.amountCents)));
  const ranked = [...amounts].sort((a, b) => compare(b[1], a[1])).slice(0, 5);
  const list = $('categoryBreakdown'); list.replaceChildren();
  if (!ranked.length) { list.append(node('p', '尚无分类支出，新增记录后将自动汇总。', 'insight-empty')); return; }
  for (const [name, amount] of ranked) {
    const row = node('div', undefined, 'category-bar');
    row.append(node('span', name), node('strong', `¥${money(amount)}`));
    const progress = node('progress'); progress.max = 100;
    progress.value = total > 0n ? Number(amount * 1000n / total) / 10 : 0;
    progress.setAttribute('aria-label', `${name}占支出${progress.value}%`);
    row.append(progress); list.append(row);
  }
}
function render() {
  const filters = Object.fromEntries(filterKeys.map(key => [key, $(key).value]));
  const visible = sorted(filterEntries(entries, filters));
  renderInsights(visible);
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
function refreshOptions() {
  for (const key of ['project', 'category']) {
    const select = $(key);
    const previous = select.value;
    const values = [...new Set(entries.map(entry => entry[key]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const all = node('option', key === 'project' ? '全部项目' : '全部类别');
    all.value = '';
    select.replaceChildren(all);
    $(`${key}Suggestions`).replaceChildren();
    for (const value of values) {
      const option = node('option', value);
      option.value = value;
      select.append(option);
      const suggestion = node('option');
      suggestion.value = value;
      $(`${key}Suggestions`).append(suggestion);
    }
    // Keep active filters even when another administrator renames the last matching entry.
    if (previous && !values.includes(previous)) {
      const option = node('option', previous);
      option.value = previous;
      select.append(option);
    }
    select.value = previous;
  }
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
function openEditor(entry = null) {
  if (!user || saving) return;
  editing = entry;
  conflicted = false;
  form.reset();
  for (const field of fields) form.elements.namedItem(field).value = entry ? (field === 'amount' ? money(entry.amountCents) : entry[field] || '') : '';
  if (!entry) {
    form.elements.namedItem('date').value = localDate();
    form.elements.namedItem('paymentStatus').value = 'unpaid';
    form.elements.namedItem('handler').value = user.nick || user.username || '';
  }
  $('dialogTitle').textContent = entry ? '编辑成本' : '新增成本';
  $('attachmentHint').textContent = entry?.attachmentId ? `当前凭证：${entry.attachmentName}。不选择文件将保留原凭证；选择新文件将替换。` : '可选；仅支持 PDF / PNG / JPEG，最大 3 MiB。';
  $('formStatus').textContent = '';
  $('saveBtn').disabled = false;
  dialog.showModal();
  form.elements.namedItem('date').focus();
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
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(payload.amount) || /^0(?:\.0{1,2})?$/.test(payload.amount)) {
    $('formStatus').textContent = '金额须大于零、最多两位小数，且不超过 999999999.99。';
    return;
  }
  if (['project', 'category', 'handler'].some(key => !payload[key].trim())) {
    $('formStatus').textContent = '项目、类别和经办人不能为空。';
    return;
  }
  if (editing) payload.version = editing.version;
  const file = form.elements.namedItem('attachment').files[0];
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
for (const key of [...filterKeys, 'sort', 'group']) $(key).addEventListener(key === 'search' ? 'input' : 'change', render);
$('resetBtn').addEventListener('click', () => {
  for (const key of [...filterKeys, 'group']) $(key).value = '';
  $('sort').value = 'date-desc';
  render();
});
$('newBtn').addEventListener('click', () => openEditor());
$('refreshBtn').addEventListener('click', loadEntries);
$('cancelBtn').addEventListener('click', () => { if (!saving) closeDialogAnimated(dialog); });
dialog.addEventListener('cancel', event => {
  if (saving) { event.preventDefault(); return; }
  event.preventDefault();
  closeDialogAnimated(dialog);
});
form.addEventListener('submit', saveEntry);
$('logoutBtn').addEventListener('click', async () => {
  try { await logout(); } catch (error) { if (!handleAuth(error)) status(`退出失败：${error.message}`, true); }
});
// "项目"栏位仍是自由文本（历史记录里可能有没在项目管理里登记过的名字），这里只是
// 把管理中枢"项目管理"里维护的项目名喂给输入框的自动完成，不强制必须从列表选。
async function loadProjectSuggestions() {
  try {
    const payload = await api('/api/admin/projects');
    const datalist = $('projectSuggestions');
    datalist.replaceChildren(...(payload.projects || []).map((project) => {
      const option = document.createElement('option');
      option.value = project.name;
      return option;
    }));
  } catch {
    // 拉取失败不影响录入成本，用户仍可以手打项目名。
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
    void loadProjectSuggestions();
    await loadEntries();
  } catch (error) {
    if (!handleAuth(error)) status(`身份验证失败：${error.message}。请重新加载页面。`, true);
  }
}
init();
