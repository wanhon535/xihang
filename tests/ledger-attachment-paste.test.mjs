// 凭证「粘贴导入」功能测试。
//
// 这里不是在断言源码字符串，而是用极简 DOM stub 把真实的
// frontend/src/pages/ledger.js 模块整体跑起来，然后构造真正的
// paste / drop / change 事件打进去，检查 DOM 状态和最终提交的 payload。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { money, totalCents, filterEntries } from '../frontend/src/ledger-utils.js';

// ---------------- 极简 DOM stub ----------------
const makeClassList = () => {
  const set = new Set();
  return {
    add: (...names) => names.forEach(name => set.add(name)),
    remove: (...names) => names.forEach(name => set.delete(name)),
    contains: name => set.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
      return on;
    }
  };
};

const makeElement = (tag, doc) => {
  const listeners = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    children: [],
    hidden: false,
    disabled: false,
    required: false,
    textContent: '',
    id: '',
    className: '',
    type: '',
    dataset: {},
    style: {},
    colSpan: 0,
    files: [],
    _value: '',
    _attributes: {},
    get value() { return this._value; },
    set value(next) { this._value = next === undefined || next === null ? '' : String(next); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    fire(type, event) {
      // 复制一份，避免 handler 内部注册新监听时边遍历边改数组。
      return Promise.all([...(listeners.get(type) || [])].map(handler => handler(event)));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    remove() {},
    focus() {},
    click() {},
    setAttribute(name, value) { this._attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null; },
    removeAttribute(name) { delete this._attributes[name]; if (name === 'src') this.src = ''; },
    reportValidity() { return true; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    reset() { if (this._fields) this._fields.forEach(field => { field._value = ''; }); }
  };
  element.classList = makeClassList();
  return element;
};

const makeDocument = () => {
  const byId = new Map();
  const listeners = new Map();
  const doc = {
    createElement: tag => makeElement(tag, doc),
    createDocumentFragment: () => makeElement('fragment', doc),
    getElementById(id) {
      if (!byId.has(id)) { const element = makeElement('div', doc); element.id = id; byId.set(id, element); }
      return byId.get(id);
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    fire(type, event) { return Promise.all([...(listeners.get(type) || [])].map(handler => handler(event))); },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  doc.body = makeElement('body', doc);
  doc.byId = byId;
  return doc;
};

// ---------------- 把真实页面模块跑起来 ----------------
// 初始隐藏状态从真实 HTML 里读出来，避免 stub 默认值和线上标记不一致导致假绿。
const LEDGER_HTML = readFileSync('frontend/ledger.html', 'utf8');
const hiddenIdsInMarkup = () => {
  const ids = new Set();
  for (const match of LEDGER_HTML.matchAll(/<[a-z]+\b([^>]*)>/gi)) {
    const attrs = match[1];
    const id = attrs.match(/\bid="([^"]+)"/);
    if (id && /\shidden(?=[\s/>]|$)/i.test(attrs)) ids.add(id[1]);
  }
  return ids;
};

const bootLedgerPage = async (fixture = {}) => {
  const doc = makeDocument();
  const calls = [];
  const stats = { fetchCalls: 0 };
  const entriesFixture = fixture.entries || [];

  for (const id of hiddenIdsInMarkup()) doc.getElementById(id).hidden = true;

  // form.elements.namedItem(...) —— saveEntry / openEditor 依赖它。
  const form = doc.getElementById('entryForm');
  const fields = new Map();
  form._fields = [];
  form.elements = {
    namedItem(name) {
      if (!fields.has(name)) { const field = makeElement('input', doc); field.name = name; fields.set(name, field); form._fields.push(field); }
      return fields.get(name);
    },
    get fieldMap() { return fields; }
  };

  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/projects') return { ok: true, projects: [{ id: '1', name: '服务器采购' }] };
    if (path === '/api/admin/costs' && (options.method || 'GET') === 'GET') {
      return { ok: true, entries: entriesFixture, summary: { totalCents: '0', monthCents: '0', unpaidCents: '0' }, month: '2026-10' };
    }
    if (path === '/api/admin/costs' && options.method === 'POST') return { ok: true, entry: { id: '9' } };
    return { ok: true };
  };

  let objectUrlSeq = 0;
  const context = vm.createContext({
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    File,
    Blob,
    URL: {
      createObjectURL: () => `blob:mock/${++objectUrlSeq}`,
      revokeObjectURL: () => {}
    },
    // 凭证缩略图走的是裸 fetch（不是 api() 封装），这里给个能返回图片的假响应。
    fetch: async () => {
      stats.fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        blob: async () => new Blob([new Uint8Array([...PNG_HEAD, 1, 2, 3, 4])], { type: 'image/png' })
      };
    },
    window: { location: { href: '', pathname: '/ledger.html', origin: 'http://localhost' } },
    // 真实纯函数；其余是可控 stub。
    money, totalCents, filterEntries,
    API_BASE_URL: '',
    setWorkspaceUser: () => {},
    showToast: () => {},
    closeDialogAnimated: () => {},
    logout: async () => {},
    redirectToLogin: () => {},
    requireUser: async () => ({ id: '1', username: 'admin', nick: '管理员', role: 'admin' }),
    api
  });

  const source = readFileSync('frontend/src/pages/ledger.js', 'utf8').replace(/^import .*$/gm, '');
  vm.runInContext(source, context, { filename: 'ledger.js' });
  await new Promise(resolve => setTimeout(resolve, 0)); // 等 init() 的 await 链落定

  const fieldSetters = {
    fill(custom = {}) {
      const values = { date: '2026-10-09', category: '云服务器', amount: '1200.50', paymentStatus: 'unpaid', handler: '万釔宏', description: '月度续费', notes: '', project: '', ...custom };
      for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value;
      // 项目和类别现在都是三段式下拉，保存时以 select 的值为准，所以两边都要设上
      doc.getElementById('entryProjectSelect').value = custom.project || '服务器采购';
      doc.getElementById('entryCategorySelect').value = custom.category || '云服务器';
    }
  };

  return { doc, form, calls, stats, $: id => doc.getElementById(id), fieldSetters };
};

// 在 stub 树里按 className 找元素
const findByClass = (root, className) => {
  for (const child of root.children || []) {
    if (typeof child.className === 'string' && child.className.split(/\s+/).includes(className)) return child;
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
};

// ---------------- 事件构造 ----------------
const makePasteEvent = (files, strings = []) => {
  const event = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    clipboardData: {
      files,
      items: [
        ...files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        ...strings.map(text => ({ kind: 'string', type: 'text/plain', getAsFile: () => null, getAsString: callback => callback(text) }))
      ],
      getData: () => strings[0] || ''
    }
  };
  return event;
};

const PNG_HEAD = [137, 80, 78, 71, 13, 10, 26, 10];
const pngFile = (extraBytes = 40) => new File([new Uint8Array([...PNG_HEAD, ...new Uint8Array(extraBytes)])], 'image.png', { type: 'image/png' });
const jpegFile = () => new File([new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 1, 2, 3])], 'image.png', { type: 'image/jpeg' });
const pdfFile = () => new File([new Uint8Array([...Buffer.from('%PDF-1.7'), 1, 2, 3])], 'image.png', { type: 'application/pdf' });

const attachmentState = $ => ({
  idleHidden: $('attachmentIdle').hidden,
  previewHidden: $('attachmentPreview').hidden,
  name: $('attachmentName').textContent,
  size: $('attachmentSize').textContent,
  imgSrc: $('attachmentPreviewImg').src || $('attachmentPreviewImg').getAttribute('src') || '',
  imgHidden: $('attachmentPreviewImg').hidden,
  clearHidden: $('attachmentClearBtn').hidden,
  hint: $('attachmentHint').textContent,
  formStatus: $('formStatus').textContent
});

// ---------------- 用例 ----------------

test('粘贴 PNG 截图：接管剪贴板、显示预览、按内容命名为 .png', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  const dialog = doc.getElementById('editDialog');
  dialog.open = true;

  const event = makePasteEvent([pngFile()]);
  await doc.fire('paste', event);

  const state = attachmentState($);
  assert.equal(event.defaultPrevented, true, '应在弹窗内接管粘贴');
  assert.equal(state.idleHidden, true, '空闲提示应隐藏');
  assert.equal(state.previewHidden, false, '预览区应出现');
  assert.equal(state.clearHidden, false, '「移除已选凭证」按钮应出现');
  assert.match(state.name, /^凭证-\d{8}-\d{6}\.png$/, `文件名应按内容命名为 .png，实际 ${state.name}`);
  assert.match(state.size, /^\d+(\.\d)? (B|KB)$/, `应显示体积，实际 ${state.size}`);
  assert.equal(state.imgHidden, false, '图片凭证应显示缩略图');
  assert.match(state.imgSrc, /^blob:/, '缩略图应指向 blob URL');
  assert.match(state.hint, /待上传凭证：.*\.png/, '提示应说明待上传凭证');
});

test('粘贴 JPEG / PDF 也能识别，且按真实格式命名（而不是盲信剪贴板里的 image.png）', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  await doc.fire('paste', makePasteEvent([jpegFile()]));
  assert.match($('attachmentName').textContent, /\.jpg$/, 'JPEG 魔数应命名为 .jpg');
  assert.equal($('attachmentPreviewImg').hidden, false, 'JPEG 也应显示缩略图');

  await doc.fire('paste', makePasteEvent([pdfFile()]));
  assert.match($('attachmentName').textContent, /\.pdf$/, 'PDF 魔数应命名为 .pdf');
  assert.equal($('attachmentPreviewImg').hidden, true, 'PDF 不显示图片缩略图');
  assert.match($('attachmentHint').textContent, /\.pdf/);
});

test('粘贴纯文本不影响正常输入（不能 intercept 掉文本粘贴）', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;
  const before = attachmentState($);

  const event = makePasteEvent([], ['这是一段备注文字']);
  await doc.fire('paste', event);

  assert.equal(event.defaultPrevented, false, '纯文本粘贴必须放行');
  assert.deepEqual(attachmentState($), before, '凭证区状态不应被改动');
});

test('弹窗未打开时不接管粘贴（避免影响页面其它输入）', async () => {
  const page = await bootLedgerPage();
  const { doc } = page;
  const event = makePasteEvent([pngFile()]);
  await doc.fire('paste', event);
  assert.equal(event.defaultPrevented, false, '弹窗关闭时不应拦截');
});

test('不支持的图片格式给出明确提示，而不是静默无反应', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  const bmp = new File([new Uint8Array([66, 77, 1, 2, 3])], 'image.bmp', { type: 'image/bmp' });
  const event = makePasteEvent([bmp]);
  await doc.fire('paste', event);

  assert.equal(event.defaultPrevented, true, '确有图片时应接管并提示');
  assert.match($('formStatus').textContent, /不是受支持的凭证格式/, '应提示格式不受支持');
  assert.equal($('attachmentPreview').hidden, true, '不应产生预览');
});

test('超过 3 MiB 的凭证被拒绝并提示', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  const bytes = new Uint8Array(3 * 1024 * 1024 + 16);
  bytes.set(PNG_HEAD, 0);
  const big = new File([bytes], 'huge.png', { type: 'image/png' });
  await doc.fire('paste', makePasteEvent([big]));

  assert.match($('formStatus').textContent, /不能超过 3 MiB/, '应提示超出体积上限');
  assert.equal($('attachmentPreview').hidden, true, '不应产生预览');
});

test('拖拽图片同样可用；点「移除已选凭证」可清空', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  const zone = $('attachmentZone');
  doc.getElementById('editDialog').open = true;

  const dropped = pngFile();
  const dropEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, dataTransfer: { files: [dropped] } };
  await zone.fire('drop', dropEvent);
  assert.equal(dropEvent.defaultPrevented, true);
  assert.equal($('attachmentPreview').hidden, false, '拖拽后应有预览');
  assert.equal(zone.classList.contains('ledger-attach-active'), false, '拖拽高亮应复位');

  await $('attachmentClearBtn').fire('click', {});
  assert.equal($('attachmentPreview').hidden, true, '移除后预览应消失');
  assert.equal($('attachmentIdle').hidden, false, '移除后应回到空闲提示');
  assert.equal($('entryAttachment').value, '', '隐藏的 file input 也应清空');
});

test('选择文件仍可用，且扩展名匹配时保留原文件名', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  const input = $('entryAttachment');
  const picked = new File([new Uint8Array([...PNG_HEAD, 1, 2, 3])], '十月服务器发票.png', { type: 'image/png' });
  input.files = [picked];
  await input.fire('change', {});

  assert.equal($('attachmentName').textContent, '十月服务器发票.png', '扩展名已匹配时应保留原文件名');
  assert.equal($('attachmentPreview').hidden, false);
});

test('粘贴的凭证会真正进入保存 payload（base64 内容与粘贴内容一致）', async () => {
  const page = await bootLedgerPage();
  const { $, doc, form, calls, fieldSetters } = page;
  doc.getElementById('editDialog').open = true;
  fieldSetters.fill();

  const pasted = pngFile(24);
  await doc.fire('paste', makePasteEvent([pasted]));
  const expectedName = $('attachmentName').textContent;

  await form.fire('submit', { preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));

  const post = calls.find(call => call.path === '/api/admin/costs' && call.options.method === 'POST');
  assert.ok(post, '应发出 POST /api/admin/costs');
  const body = JSON.parse(post.options.body);
  assert.ok(body.attachment, 'payload 应带上凭证');
  assert.equal(body.attachment.name, expectedName, '凭证名应与预览一致');
  assert.equal(body.project, '服务器采购', '项目应来自下拉');
  assert.equal(body.category, '云服务器', '类别应来自下拉');

  const decoded = Buffer.from(body.attachment.data, 'base64');
  assert.deepEqual([...decoded.subarray(0, 8)], PNG_HEAD, 'base64 解码后应是原始 PNG 字节');
  assert.equal(decoded.length, pasted.size, '上传字节数应与粘贴文件一致');
});

test('页面标记：凭证区提供粘贴入口，且初始隐藏预览与移除按钮', () => {
  assert.match(LEDGER_HTML, /id="attachmentZone"/, '应有粘贴/拖拽区域');
  assert.match(LEDGER_HTML, /Ctrl[\s\S]{0,120}V<\/kbd> 粘贴截图/, '应明确提示 Ctrl+V 粘贴截图');
  const fileInput = LEDGER_HTML.match(/<input[^>]*id="entryAttachment"[^>]*>/);
  assert.ok(fileInput, '凭证栏仍要有隐藏的文件选择入口（兼容原上传方式）');
  assert.match(fileInput[0], /name="attachment"/, '必须保留 name="attachment"，后端字段名不能变');
  assert.match(fileInput[0], /type="file"/);
  const hidden = hiddenIdsInMarkup();
  assert.ok(hidden.has('attachmentPreview'), '初始应隐藏预览区');
  assert.ok(hidden.has('attachmentClearBtn'), '初始应隐藏「移除已选凭证」');
  assert.ok(!hidden.has('attachmentIdle'), '空闲态提示初始应可见');
});

test('构建产物已带上粘贴导入（dist 与源码一致）', () => {
  if (!existsSync('dist/ledger.html')) return; // 未构建时跳过，不误报
  const distHtml = readFileSync('dist/ledger.html', 'utf8');
  assert.match(distHtml, /id="attachmentZone"/);
  assert.match(distHtml, /id="entryAttachment"/);
  const bundle = readdirSync('dist/assets').find(name => /^ledger-.*\.js$/.test(name));
  assert.ok(bundle, '应存在 ledger 的构建产物');
  const code = readFileSync(`dist/assets/${bundle}`, 'utf8');
  assert.match(code, /clipboardData/, '构建产物应包含剪贴板处理逻辑');
  assert.match(code, /不是受支持的凭证格式/, '构建产物应包含格式错误提示');
  assert.match(code, /粘贴截图/, '构建产物应包含粘贴提示文案');
});

// ---------------- 本轮新增：类别下拉 / 凭证出图 / 项目维度展示 ----------------

const FIXTURE = [
  { id: '1', date: '2026-04-09', project: '美国C类公司成本', category: '跨境电商', amountCents: '180000', paymentStatus: 'paid', handler: '2R.T5z', description: '', notes: '' },
  { id: '2', date: '2026-05-04', project: '1060U', category: '跨境电商', amountCents: '726100', paymentStatus: 'paid', handler: '尹亿祥', description: '', notes: '' },
  { id: '3', date: '2026-04-28', project: '服务器', category: '采购', amountCents: '6000', paymentStatus: 'paid', handler: '万釔宏', description: '', notes: '' }
];

test('新增成本时「类别」下拉把台账里已有的类别全带出来', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $, doc } = page;

  // 走真实路径：点「＋新增成本」→ 刷新项目 → openEditor
  await $('newBtn').fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(doc.getElementById('editDialog').open, true, '应打开新增弹窗');
  const options = $('entryCategorySelect').children.map(option => option.textContent);
  for (const expected of ['跨境电商', '采购']) {
    assert.ok(options.includes(expected), `类别下拉应含「${expected}」，实际：${options.join(' / ')}`);
  }
  assert.ok(options.some(text => /其他（手填类别）/.test(text)), '应保留手填兜底项');
  assert.match($('categoryFieldHint').textContent, /2 个类别/, '提示应说明带出了几个类别');
});

test('新增成本时选择「其他」才露出类别手填框', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $ } = page;
  await $('newBtn').fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal($('entryCategoryCustom').hidden, true, '默认不显示手填框');
  $('entryCategorySelect').value = '__custom__';
  await $('entryCategorySelect').fire('change', {});
  assert.equal($('entryCategoryCustom').hidden, false, '选「其他」后应露出手填框');
  assert.equal($('entryCategoryCustom').required, true, '手填时必填');
});

test('凭证列直接渲染缩略图，点开看大图（且同一张只请求一次）', async () => {
  const entries = [{ ...FIXTURE[0], attachmentId: '11', attachmentName: '凭证-2026-04-09-6.png' }];
  const page = await bootLedgerPage({ entries });
  const { $, stats } = page;
  await new Promise(resolve => setTimeout(resolve, 0));

  const cell = findByClass($('rows'), 'ledger-voucher');
  assert.ok(cell, '凭证单元格应渲染成 .ledger-voucher');
  const thumb = findByClass(cell, 'ledger-voucher-thumb');
  assert.ok(thumb, '应有缩略图按钮');
  await new Promise(resolve => setTimeout(resolve, 0)); // 等 paintThumb

  const image = thumb.children[0];
  assert.equal(image.tagName, 'IMG', `缩略图应真的渲染出 <img>，实际：${thumb.textContent}`);
  assert.match(image.src, /^blob:/, '缩略图应指向 blob URL');
  assert.match(thumb.getAttribute('aria-label'), /查看凭证/, '缩略图应有可访问名称');
  assert.equal(stats.fetchCalls, 1, '应恰好为这张凭证请求一次');

  await thumb.fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('voucherDialog').open, true, '点击缩略图应打开大图弹窗');
  assert.match($('voucherImage').src, /^blob:/, '大图应显示凭证');
  assert.equal($('voucherImage').hidden, false);
  assert.match($('voucherMeta').textContent, /美国C类公司成本/);
  assert.equal(stats.fetchCalls, 1, '大图应复用缩略图已缓存的 blob，不重复请求');

  await $('voucherCloseBtn').fire('click', {});
});

test('PDF 凭证不硬塞 <img>，提示去下载', async () => {
  const entries = [{ ...FIXTURE[0], attachmentId: '12', attachmentName: '发票.pdf' }];
  const page = await bootLedgerPage({ entries });
  const { $ } = page;
  await new Promise(resolve => setTimeout(resolve, 0));

  const thumb = findByClass($('rows'), 'ledger-voucher-thumb');
  assert.equal(thumb.textContent, 'PDF', 'PDF 缩略图应显示格式标记而不是图片');
  await thumb.fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match($('voucherMeta').textContent, /PDF 无法直接预览/);
  assert.equal($('voucherImage').hidden, true, 'PDF 不应显示 <img>');
});

test('概览区「类别」和「项目」两个维度口径一致（含笔数）', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $ } = page;

  const projectBars = $('projectBreakdown').children;
  assert.equal(projectBars.length, 3, '三个项目应各占一行');
  assert.match(projectBars[0].children[0].textContent, /1060U/, '项目应按金额降序，1060U 最大');
  assert.equal(projectBars[0].children[2].textContent, '1 笔', '项目条应显示笔数');

  const categoryBars = $('categoryBreakdown').children;
  assert.equal(categoryBars.length, 2, '两个类别');
  assert.match(categoryBars[0].children[0].textContent, /跨境电商/, '跨境电商金额最大');
  assert.equal(categoryBars[0].children[2].textContent, '2 笔', '类别条也应显示笔数');
});

test('页面标记：类别是下拉、有项目分布面板与凭证大图弹窗', () => {
  assert.match(LEDGER_HTML, /id="entryCategorySelect"/, '类别应改为下拉');
  assert.match(LEDGER_HTML, /id="entryCategoryCustom"[^>]*hidden/, '应保留手填兜底且默认隐藏');
  assert.match(LEDGER_HTML, /id="projectBreakdown"/, '应有项目分布面板');
  assert.match(LEDGER_HTML, /id="voucherDialog"/, '应有凭证大图弹窗');
  assert.match(LEDGER_HTML, /id="voucherImage"/);
});
