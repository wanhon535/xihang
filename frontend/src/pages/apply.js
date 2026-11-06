// 汐航 · 申请中心（配置驱动）
// 页面自身不认识任何具体表单：卡片、字段、校验全部来自 /api/apply/catalog。
// 新增一类申请 = 后端 APPLY_FORMS 加一项，本文件不用改。
import { setWorkspaceUser } from '../shell.js';
import { api, logout, requireUser } from '../api.js';
import { showToast } from '../ui-feedback.js';

const $ = (sel) => document.querySelector(sel);

const statusEl = $('#applyStatus');
const hero = $('#applyHero');
const grid = $('#applyGrid');
const emptyEl = $('#applyEmpty');
const modal = $('#applyModal');
const dialog = modal ? modal.querySelector('.apply-dialog') : null;
const dialogTitle = $('#applyDialogTitle');
const dialogSubtitle = $('#applyDialogSubtitle');
const dialogIcon = $('#applyDialogIcon');
const closeBtn = $('#applyDialogClose');
const form = $('#applyForm');
const fieldsBox = $('#applyFields');
const formError = $('#applyFormError');
const formHint = $('#applyFormHint');
const submitBtn = $('#applySubmitBtn');
const cancelBtn = $('#applyCancelBtn');
const doneBox = $('#applyDone');
const doneText = $('#applyDoneText');
const doneTable = $('#applyDoneTable');
const doneAgain = $('#applyDoneAgain');
const doneClose = $('#applyDoneClose');

const ICONS = {
  clock: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"/><path d="M12 7.5V12l3 2"/>',
  cart: '<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>',
  form: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h4"/>'
};

let catalog = null;
let activeForm = null;
let lastFocused = null;

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.form}</svg>`;
}

function setStatus(text, tone = '') {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.className = tone ? `apply-status ${tone}` : 'apply-status';
  statusEl.hidden = !text;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------
function renderCards(forms) {
  const tip = `<p class="apply-grid-note"><strong>需要别的类型？</strong>告诉管理员，加好后这里会自动出现对应的申请表。</p>`;

  grid.innerHTML =
    forms
      .map(
        (form) => `<button type="button" class="apply-card accent-${escapeHtml(form.accent || 'blue')}" data-key="${escapeHtml(form.key)}">
  <span class="apply-card-icon">${iconSvg(form.icon)}</span>
  <span class="apply-card-main">
    <strong>${escapeHtml(form.title)}</strong>
    <small>${escapeHtml(form.subtitle || '')}</small>
    <p>${escapeHtml(form.description || '')}</p>
  </span>
  <span class="apply-card-foot">
    <span class="apply-card-meta">${form.fieldCount} 个字段 · ${form.requiredCount} 项必填</span>
    <span class="apply-card-go">填写 →</span>
  </span>
</button>`
      )
      .join('') + tip;

  grid.querySelectorAll('.apply-card').forEach((card) => {
    card.addEventListener('click', () => openForm(card.dataset.key, card));
  });
}

// ---------------------------------------------------------------------------
// 表单渲染
// ---------------------------------------------------------------------------
function fieldControl(field) {
  const id = `af_${field.key}`;
  const required = field.required ? 'required' : '';
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const maxlength = field.max ? ` maxlength="${field.max}"` : '';

  if (field.type === 'amountList') {
    return `<div class="apply-amounts" data-amounts="${escapeHtml(field.key)}" data-max="${field.maxEntries || 30}">
      <div class="apply-amount-head" aria-hidden="true">
        <span>商品 / 规格</span><span>金额（元）</span><span></span>
      </div>
      <div class="apply-amount-rows"></div>
      <div class="apply-amount-foot">
        <button type="button" class="apply-amount-add">＋ 添加一条金额</button>
        <span class="apply-amount-total">合计<b>¥0.00</b></span>
      </div>
    </div>`;
  }
  if (field.type === 'select') {
    const options = (field.options || [])
      .map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
      .join('');
    return `<select id="${id}" name="${field.key}" ${required}>
      <option value="">请选择</option>${options}
    </select>`;
  }
  if (field.type === 'textarea') {
    const rows = field.rows || 2;
    return `<textarea id="${id}" name="${field.key}" rows="${rows}"${placeholder}${maxlength} ${required}></textarea>`;
  }
  if (field.type === 'date') {
    return `<input id="${id}" name="${field.key}" type="date" ${required} />`;
  }
  if (field.type === 'number') {
    return `<input id="${id}" name="${field.key}" type="number" min="1" step="1"${placeholder} />`;
  }
  if (field.type === 'currency') {
    return `<input id="${id}" name="${field.key}" type="number" min="0" step="0.01"${placeholder} ${required} />`;
  }
  if (field.type === 'owner') {
    const nick = escapeHtml(catalog?.applicant?.nick || '');
    const canAssign = catalog?.applicant?.canAssignOwner;
    // 提示放进输入框右侧的徽标里，不再单独占一行 —— 否则这一格的 help 文本
    // 会把这个字段撑高，把两列栅格的对齐线拉歪。
    return `<span class="apply-input-wrap">
      <input id="${id}" type="text" value="${nick}" readonly aria-describedby="${id}_hint" />
      <span id="${id}_hint" class="apply-input-badge" title="${
        canAssign ? '自动取当前登录账号' : '当前账号没绑定钉钉身份，负责人需到台账内补填'
      }">${canAssign ? '自动带入' : '需到台账补填'}</span>
    </span>`;
  }
  return `<input id="${id}" name="${field.key}" type="text"${placeholder}${maxlength} ${required} />`;
}

function renderFields(fields) {
  const chunks = [];
  // 先算出每个字段的「实际分组」——空 section 表示沿用上一组（这样配置里
  // 只需在组首标一次，不用每条重复写）。
  let cursor = '';
  const effective = fields.map((field) => {
    const name = (field.section || '').trim();
    if (name) cursor = name;
    return cursor;
  });
  // 只有 ≥2 个字段的分组才画标题 —— 单字段分组（如只有「资源名称」的
  // 基本信息）加标题只会把表单切成碎片。
  const sectionSize = effective.reduce((map, name) => {
    if (name) map.set(name, (map.get(name) || 0) + 1);
    return map;
  }, new Map());

  let lastSection = null;
  fields.forEach((field, index) => {
    const section = effective[index];
    if (section && section !== lastSection && (sectionSize.get(section) || 0) > 1) {
      chunks.push(`<div class="apply-section" role="presentation">${escapeHtml(section)}</div>`);
    }
    lastSection = section;
    // help 做成标题后的问号气泡，而不是输入框下方的一行小字：
    // 那一行会把该格撑高，同一行另一个字段的输入框就错位了。
    const tip = field.help
      ? `<i class="apply-label-tip" tabindex="0" role="note" aria-label="${escapeHtml(field.help)}" data-tip="${escapeHtml(field.help)}">?</i>`
      : '';
    const tag = field.type === 'amountList' ? 'div' : 'label';
    chunks.push(`<${tag} class="apply-field${field.wide ? ' apply-field-wide' : ''}" data-key="${escapeHtml(field.key)}">
  <span class="apply-field-label">${escapeHtml(field.label)}${field.required ? '<em>*</em>' : ''}${tip}</span>
  ${fieldControl(field)}
</${tag}>`);
  });
  fieldsBox.innerHTML = chunks.join('');
  // 可重复金额：每张开好的表单先给一条空行，用户点「＋」再加
  fieldsBox.querySelectorAll('.apply-amounts').forEach((box) => addAmountRow(box, false));
  updateProgress();
}

// ---------------------------------------------------------------------------
// 可重复的金额列表
// ---------------------------------------------------------------------------
function amountRowHtml() {
  return `<div class="apply-amount-row">
  <input type="text" class="apply-amount-label" placeholder="商品 / 规格（选填）" maxlength="100" />
  <input type="number" class="apply-amount-value" placeholder="金额" min="0" step="0.01" inputmode="decimal" />
  <button type="button" class="apply-amount-del" aria-label="删除这条金额">×</button>
</div>`;
}

function addAmountRow(box, focus = true) {
  const rows = box.querySelector('.apply-amount-rows');
  const max = Number(box.dataset.max) || 30;
  if (rows.children.length >= max) return;
  rows.insertAdjacentHTML('beforeend', amountRowHtml());
  syncAmountRows(box);
  if (focus) rows.lastElementChild?.querySelector('input')?.focus();
}

function syncAmountRows(box) {
  const rows = [...box.querySelectorAll('.apply-amount-row')];
  // 只剩一条时不给删，避免用户把整个控件删空后不知道怎么办
  rows.forEach((row) => {
    row.querySelector('.apply-amount-del').disabled = rows.length <= 1;
  });
  const max = Number(box.dataset.max) || 30;
  const addBtn = box.querySelector('.apply-amount-add');
  if (addBtn) {
    addBtn.disabled = rows.length >= max;
    addBtn.textContent = rows.length >= max ? `已达上限 ${max} 条` : '＋ 添加一条金额';
  }
  recalcAmounts(box);
}

function recalcAmounts(box) {
  const total = [...box.querySelectorAll('.apply-amount-value')].reduce((sum, input) => {
    const value = Number(input.value);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const label = box.querySelector('.apply-amount-total b');
  if (label) label.textContent = `¥${total.toFixed(2)}`;
}

function collectAmounts(fieldKey) {
  const box = fieldsBox.querySelector(`.apply-amounts[data-amounts="${fieldKey}"]`);
  if (!box) return [];
  return [...box.querySelectorAll('.apply-amount-row')]
    .map((row) => ({
      label: row.querySelector('.apply-amount-label')?.value.trim() || '',
      amount: row.querySelector('.apply-amount-value')?.value.trim() || ''
    }))
    .filter((item) => item.amount !== '');
}

function hasAmountValue(fieldKey) {
  return collectAmounts(fieldKey).length > 0;
}

// 统一「这个字段算不算填了」，金额列表和普通输入框走同一套判断
function fieldElement(field) {
  if (field.type === 'amountList') {
    return fieldsBox.querySelector(`.apply-amounts[data-amounts="${field.key}"]`);
  }
  return fieldsBox.querySelector(`[name="${field.key}"]`);
}

function isFieldFilled(field) {
  if (field.type === 'amountList') return hasAmountValue(field.key);
  const el = fieldElement(field);
  return Boolean(el && String(el.value || '').trim() !== '');
}

// 必填项进度：让长表单知道还差什么，而不是滚到底才发现没填
function updateProgress() {
  if (!formHint || !activeForm) return;
  const required = (activeForm.fields || []).filter((f) => f.required && f.type !== 'owner');
  const ownerRequired = (activeForm.fields || []).some((f) => f.required && f.type === 'owner');
  const filled = required.filter(isFieldFilled).length;
  const total = required.length + (ownerRequired ? 1 : 0);
  const done = filled + (ownerRequired ? 1 : 0);
  if (!total) {
    formHint.textContent = '全部选填，可直接提交';
    formHint.dataset.state = 'ready';
    return;
  }
  const left = total - done;
  if (left === 0) {
    formHint.textContent = '必填已填完，可以提交';
    formHint.dataset.state = 'ready';
  } else if (done === 0) {
    // 刚打开时只报量，不用「还差 N 项」催促
    formHint.textContent = `必填 ${total} 项`;
    formHint.dataset.state = 'pending';
  } else {
    formHint.textContent = `还差 ${left} 项必填`;
    formHint.dataset.state = 'pending';
  }
}

function clearFieldErrors() {
  fieldsBox.querySelectorAll('.apply-field.has-error').forEach((el) => el.classList.remove('has-error'));
}

// 前端先做一遍必填校验，避免空表单打到后端再弹一句「缺少必填字段」
function validateRequired() {
  clearFieldErrors();
  const missing = [];
  (activeForm?.fields || []).forEach((field) => {
    if (!field.required || field.type === 'owner') return;
    if (isFieldFilled(field)) return;
    const el = fieldElement(field);
    if (!el) return;
    missing.push({ field, el });
    el.closest('.apply-field')?.classList.add('has-error');
  });
  return missing;
}

function resetDialogState() {
  form.hidden = false;
  doneBox.hidden = true;
  formError.textContent = '';
  form.reset();
  submitBtn.disabled = false;
  submitBtn.textContent = '提交';
  updateProgress();
}

function openForm(key, trigger) {
  const target = (catalog?.forms || []).find((item) => item.key === key);
  if (!target) return;
  activeForm = target;
  lastFocused = trigger || document.activeElement;

  dialogTitle.textContent = target.title;
  dialogSubtitle.textContent = target.subtitle || '';
  dialogIcon.innerHTML = iconSvg(target.icon);
  dialogIcon.className = `apply-icon accent-${target.accent || 'blue'}`;

  renderFields(target.fields || []);
  resetDialogState();

  modal.hidden = false;
  document.body.classList.add('apply-modal-open');
  const first = fieldsBox.querySelector('input:not([readonly]), select, textarea');
  if (first) first.focus({ preventScroll: true });
}

function closeModal() {
  modal.hidden = true;
  document.body.classList.remove('apply-modal-open');
  activeForm = null;
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------
async function submitForm(event) {
  event.preventDefault();
  if (!activeForm) return;
  formError.textContent = '';

  const missing = validateRequired();
  if (missing.length) {
    formError.textContent =
      missing.length === 1
        ? `请填写「${missing[0].field.label}」`
        : `还有 ${missing.length} 项必填没填：${missing.slice(0, 3).map((m) => m.field.label).join('、')}${missing.length > 3 ? ' 等' : ''}`;
    missing[0].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    missing[0].el.focus({ preventScroll: true });
    updateProgress();
    return;
  }

  const values = {};
  new FormData(form).forEach((value, key) => {
    values[key] = typeof value === 'string' ? value.trim() : value;
  });
  // 金额列表的输入框没有 name（避免被 FormData 拆散），单独收集
  (activeForm.fields || []).forEach((field) => {
    if (field.type === 'amountList') values[field.key] = collectAmounts(field.key);
  });

  submitBtn.disabled = true;
  submitBtn.textContent = '写入中…';
  formHint.textContent = '正在写入台账…';
  try {
    const result = await api(`/api/apply/${activeForm.key}`, {
      method: 'POST',
      body: JSON.stringify({ values })
    });
    form.hidden = true;
    doneBox.hidden = false;
    const extra = result.ownerAssigned === false ? '（负责人需到台账内补填）' : '';
    doneText.textContent = `${activeForm.successText}${extra}`;
    doneTable.href = result.tableViewUrl || activeForm.tableViewUrl || '#';
    formHint.textContent = '';
    showToast(activeForm.successText, doneAgain);
  } catch (error) {
    formError.textContent = error?.message || '提交失败，请稍后重试';
    updateProgress();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交';
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const user = await requireUser();
    if (!user) return;
    if ($('#userName')) $('#userName').textContent = user.nick || user.username;
    setWorkspaceUser(user);

    catalog = await api('/api/apply/catalog');
    const forms = catalog.forms || [];

    const greeting = $('#heroGreeting');
    if (greeting) greeting.textContent = `你好，${catalog.applicant?.nick || user.nick || user.username}`;
    if ($('#heroFormCount')) $('#heroFormCount').textContent = String(forms.length);
    if ($('#heroFieldCount')) $('#heroFieldCount').textContent = String(forms.reduce((n, f) => n + (f.fieldCount || 0), 0));

    hero.hidden = false;
    if (!forms.length) {
      emptyEl.hidden = false;
      setStatus('');
      return;
    }
    renderCards(forms);
    setStatus('');
  } catch (error) {
    if (error?.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    setStatus(error?.message || '加载失败，请刷新重试', 'error');
  }
}

if (closeBtn) closeBtn.addEventListener('click', closeModal);
if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
if (doneClose) doneClose.addEventListener('click', closeModal);
if (doneAgain) doneAgain.addEventListener('click', () => { if (activeForm) openForm(activeForm.key, null); });
if (form) form.addEventListener('submit', submitForm);
if (fieldsBox) {
  fieldsBox.addEventListener('input', (event) => {
    event.target.closest?.('.apply-field')?.classList.remove('has-error');
    const box = event.target.closest?.('.apply-amounts');
    if (box) recalcAmounts(box);
    updateProgress();
  });
  fieldsBox.addEventListener('change', (event) => {
    // 金额失焦补两位小数，和底部合计的格式保持一致
    const value = event.target.closest?.('.apply-amount-value');
    if (value && value.value !== '') {
      const num = Number(value.value);
      if (Number.isFinite(num) && num >= 0) {
        value.value = num.toFixed(2);
        recalcAmounts(value.closest('.apply-amounts'));
      }
    }
    updateProgress();
  });
  fieldsBox.addEventListener('click', (event) => {
    const box = event.target.closest?.('.apply-amounts');
    if (!box) return;
    if (event.target.closest?.('.apply-amount-add')) {
      event.preventDefault();
      addAmountRow(box);
      updateProgress();
      return;
    }
    const del = event.target.closest?.('.apply-amount-del');
    if (del) event.preventDefault();
    if (del && box.querySelectorAll('.apply-amount-row').length > 1) {
      del.closest('.apply-amount-row')?.remove();
      syncAmountRows(box);
      updateProgress();
    }
  });
}
if (modal) {
  modal.addEventListener('click', (event) => {
    if (event.target?.dataset?.close === '1') closeModal();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
});
if ($('#logoutBtn')) $('#logoutBtn').addEventListener('click', () => logout());

boot();
