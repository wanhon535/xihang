// 凭证「粘贴导入」功能测试。
//
// 这里不是在断言源码字符串，而是用极简 DOM stub 把真实的
// frontend/src/pages/ledger.js 模块整体跑起来，然后构造真正的
// paste / drop / change 事件打进去，检查 DOM 状态和最终提交的 payload。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  // 图片压缩器：页面里调用的是 image-fit.js 的 shrinkImageToLimit。这里默认给一个
  // 「能压但会记录调用」的假实现，模拟现代浏览器；传 fixture.shrink 可换成失败/自定义版本。
  const shrinkCalls = [];
  const fakeShrink = async (file, limit, options = {}) => {
    shrinkCalls.push({ size: file.size, limit, type: options.type, scales: options.scales });
    if (options.type === 'image/png') {
      // 模拟「无损缩放压不进 3 MiB」：返回一个仍然超限的 PNG，逼页面回落到 JPEG 分支。
      const size = Math.min(file.size, limit + 1024);
      return new Blob([new Uint8Array([...PNG_HEAD, ...new Uint8Array(Math.max(size - PNG_HEAD.length, 8))])], { type: 'image/png' });
    }
    const size = Math.max(Math.min(Math.round(file.size / 4), limit - 4096), 1024);
    return new Blob([new Uint8Array([255, 216, 255, 224, ...new Uint8Array(Math.max(size - 4, 8))])], { type: 'image/jpeg' });
  };
  const shrink = fixture.shrink || fakeShrink;
  const context = vm.createContext({
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    File,
    Blob,
    // 源码里的 import 行被剥掉了，这里把被引用的依赖按名字补进作用域。
    shrinkImageToLimit: shrink,
    LOSSLESS_PLAN: { scales: [1, 0.7, 0.5, 0.35], qualities: [1, 1, 1, 1] },
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

  return { doc, form, calls, stats, shrinkCalls, $: id => doc.getElementById(id), fieldSetters };
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

// 凭证区现在是一个「待上传凭证列表」：每张一行 .ledger-attach-item。
const attachItems = $ => $('attachmentPreview').children || [];
const itemName = item => (findByClass(item, 'ledger-attach-name') || {}).textContent || '';
const itemSize = item => (findByClass(item, 'ledger-attach-size') || {}).textContent || '';
const itemThumb = item => findByClass(item, 'ledger-attach-thumb');
const firstName = $ => (attachItems($)[0] ? itemName(attachItems($)[0]) : '');
const firstSize = $ => (attachItems($)[0] ? itemSize(attachItems($)[0]) : '');
const firstThumb = $ => (attachItems($)[0] ? itemThumb(attachItems($)[0]) : null);
const firstThumbSrc = $ => { const thumb = firstThumb($); return thumb ? (thumb.src || thumb.getAttribute('src') || '') : ''; };

const attachmentState = $ => ({
  idleHidden: $('attachmentIdle').hidden,
  previewHidden: $('attachmentPreview').hidden,
  count: attachItems($).length,
  name: firstName($),
  size: firstSize($),
  thumbTag: firstThumb($) ? firstThumb($).tagName : '',
  thumbSrc: firstThumbSrc($),
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
  assert.equal(state.count, 1, '应列出 1 张待上传凭证');
  assert.match(state.name, /^凭证-\d{8}-\d{6}\.png$/, `文件名应按内容命名为 .png，实际 ${state.name}`);
  assert.match(state.size, /^\d+(\.\d)? (B|KB)$/, `应显示体积，实际 ${state.size}`);
  assert.equal(state.thumbTag, 'IMG', '图片凭证应显示缩略图');
  assert.match(state.thumbSrc, /^blob:/, '缩略图应指向 blob URL');
  assert.match(state.hint, /待上传凭证：.*\.png/, '提示应说明待上传凭证');
});

test('粘贴 JPEG / PDF 也能识别，且按真实格式命名（而不是盲信剪贴板里的 image.png）', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  await doc.fire('paste', makePasteEvent([jpegFile()]));
  assert.match(firstName($), /\.jpg$/, 'JPEG 魔数应命名为 .jpg');
  assert.equal(firstThumb($).tagName, 'IMG', 'JPEG 也应显示缩略图');

  await doc.fire('paste', makePasteEvent([pdfFile()]));
  assert.equal(attachItems($).length, 2, '第二张凭证应追加，而不是把第一张替换掉');
  const pdfItem = attachItems($)[1];
  assert.match(itemName(pdfItem), /\.pdf$/, 'PDF 魔数应命名为 .pdf');
  assert.equal(itemThumb(pdfItem).tagName, 'SPAN', 'PDF 不显示图片缩略图');
  assert.equal(itemThumb(pdfItem).textContent, 'PDF', 'PDF 用格式标记代替缩略图');
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

test('非图片/非 PDF 的剪贴板文件给出明确提示，而不是静默无反应', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  const zip = new File([new Uint8Array([80, 75, 3, 4, 1, 2, 3])], '发票.zip', { type: 'application/zip' });
  const event = makePasteEvent([zip]);
  await doc.fire('paste', event);

  assert.equal(event.defaultPrevented, true, '确有文件时应接管并提示');
  assert.match($('formStatus').textContent, /不是受支持的凭证格式/, '应提示格式不受支持');
  assert.equal($('attachmentPreview').hidden, true, '不应产生预览');
});

test('非常规图片格式（如 WebP / BMP）自动转成 JPEG，而不是被拒收', async () => {
  const page = await bootLedgerPage();
  const { $, doc, shrinkCalls } = page;
  doc.getElementById('editDialog').open = true;

  // 小图、但魔数不是 PNG/JPEG（模拟 WebP 粘贴）：旧逻辑会直接拒收。
  const webp = new File([new Uint8Array([82, 73, 70, 70, 4, 5, 6, 7, 87, 69, 66, 80])], 'image.webp', { type: 'image/webp' });
  await doc.fire('paste', makePasteEvent([webp]));

  assert.equal($('attachmentPreview').hidden, false, 'WebP 应能直接预览');
  assert.match(firstName($), /^凭证-\d{8}-\d{6}\.jpg$/, '应转成 .jpg 命名');
  assert.match($('formStatus').textContent, /已自动转为 JPEG/, '应说明做了什么转换');
  assert.ok(shrinkCalls.some(call => call.type === 'image/jpeg'), '应调用 JPEG 转换');
});

test('超过 3 MiB 的 JPEG 凭证自动压缩后放行（不再直接拒收）', async () => {
  const page = await bootLedgerPage();
  const { $, doc, form, calls, shrinkCalls, fieldSetters } = page;
  doc.getElementById('editDialog').open = true;
  fieldSetters.fill();

  const bytes = new Uint8Array(6 * 1024 * 1024);
  bytes.set([255, 216, 255, 224], 0);
  const big = new File([bytes], '手机拍发票.jpg', { type: 'image/jpeg' });
  await doc.fire('paste', makePasteEvent([big]));

  assert.equal($('attachmentPreview').hidden, false, '压缩后应产生预览');
  assert.match(firstName($), /^凭证-\d{8}-\d{6}\.jpg$/, '应重命名为 .jpg');
  assert.match($('formStatus').textContent, /已自动压缩/, '应提示已压缩');
  assert.ok(shrinkCalls.length >= 1, '应走过压缩链路');

  // 真正保存：payload 里的 base64 必须 ≤ 3 MiB（4194304 字符上限）
  await form.fire('submit', { preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const post = calls.find(call => call.path === '/api/admin/costs' && call.options.method === 'POST');
  const body = JSON.parse(post.options.body);
  assert.equal(body.attachments.length, 1, '一张凭证进 attachments 数组');
  assert.ok(body.attachments[0].data.length <= 4 * 1024 * 1024, 'base64 不能超过后端上限');
  const decoded = Buffer.from(body.attachments[0].data, 'base64');
  assert.ok(decoded.length <= 3 * 1024 * 1024, '压缩后二进制必须 ≤ 3 MiB');
  assert.deepEqual([...decoded.subarray(0, 3)], [255, 216, 255], '压缩结果应是合法 JPEG');
});

test('超过 3 MiB 的 PNG 先试无损缩放，压不进去再回落 JPEG', async () => {
  const page = await bootLedgerPage();
  const { $, doc, shrinkCalls } = page;
  doc.getElementById('editDialog').open = true;

  const bytes = new Uint8Array(5 * 1024 * 1024);
  bytes.set(PNG_HEAD, 0);
  const big = new File([bytes], 'huge.png', { type: 'image/png' });
  await doc.fire('paste', makePasteEvent([big]));

  assert.equal(shrinkCalls[0].type, 'image/png', '第一档应是无损缩放');
  assert.ok(shrinkCalls.some(call => call.type === 'image/jpeg'), '无损压不下时应回落 JPEG');
  assert.equal($('attachmentPreview').hidden, false, '最终仍应放行（已压缩）');
  assert.match(firstName($), /\.jpg$/, '回落 JPEG 后应按 jpg 命名');
});

test('浏览器不支持压缩（老环境）时，超限凭证仍给出明确提示而非静默失败', async () => {
  const page = await bootLedgerPage({ shrink: async () => { throw new Error('no canvas'); } });
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

  assert.equal(firstName($), '十月服务器发票.png', '扩展名已匹配时应保留原文件名');
  assert.equal($('attachmentPreview').hidden, false);
});

test('粘贴的凭证会真正进入保存 payload（base64 内容与粘贴内容一致）', async () => {
  const page = await bootLedgerPage();
  const { $, doc, form, calls, fieldSetters } = page;
  doc.getElementById('editDialog').open = true;
  fieldSetters.fill();

  const pasted = pngFile(24);
  await doc.fire('paste', makePasteEvent([pasted]));
  const expectedName = firstName($);

  await form.fire('submit', { preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));

  const post = calls.find(call => call.path === '/api/admin/costs' && call.options.method === 'POST');
  assert.ok(post, '应发出 POST /api/admin/costs');
  const body = JSON.parse(post.options.body);
  assert.ok(body.attachments && body.attachments.length === 1, 'payload 应带上凭证数组');
  assert.equal(body.attachments[0].name, expectedName, '凭证名应与预览一致');
  assert.equal(body.project, '服务器采购', '项目应来自下拉');
  assert.equal(body.category, '云服务器', '类别应来自下拉');

  const decoded = Buffer.from(body.attachments[0].data, 'base64');
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
  assert.match(fileInput[0], /multiple/, '文件选择必须允许多选，否则多凭证根本选不进来');
  const hidden = hiddenIdsInMarkup();
  assert.ok(hidden.has('attachmentPreview'), '初始应隐藏预览区');
  assert.ok(hidden.has('attachmentClearBtn'), '初始应隐藏「移除已选凭证」');
  assert.ok(hidden.has('attachmentExisting'), '初始应隐藏「已有凭证」区');
  assert.ok(hidden.has('voucherNav'), '单张凭证时不必显示左右翻页');
  assert.ok(!hidden.has('attachmentIdle'), '空闲态提示初始应可见');
});

test('构建产物已带上粘贴导入（dist 与源码一致）', () => {
  if (!existsSync('dist/ledger.html')) return; // 未构建时跳过，不误报
  const distHtml = readFileSync('dist/ledger.html', 'utf8');
  assert.match(distHtml, /id="attachmentZone"/);
  assert.match(distHtml, /id="entryAttachment"/);
  // 注意：dist/assets 里还有一个 ledger-utils-*.js（纯函数单独切出来的 chunk），
  // 光用 /^ledger-/ 会误取到它。按体积取最大的那个才是页面主 bundle。
  const candidates = readdirSync('dist/assets').filter(name => /^ledger-.*\.js$/.test(name));
  const bundle = candidates
    .map(name => ({ name, size: statSync(`dist/assets/${name}`).size }))
    .sort((a, b) => b.size - a.size)[0]?.name;
  assert.ok(bundle, '应存在 ledger 的构建产物');
  const code = readFileSync(`dist/assets/${bundle}`, 'utf8');
  assert.match(code, /clipboardData/, '构建产物应包含剪贴板处理逻辑');
  assert.match(code, /不是受支持的凭证格式/, '构建产物应包含格式错误提示');
  assert.match(code, /removeAttachmentIds/, '构建产物应包含「一条记录多张凭证」的追加/删除逻辑');
  assert.match(code, /清空已选凭证/, '构建产物应包含多凭证的操作文案');
  // 注意：「粘贴截图」这句提示现在只在 ledger.html 里（凭证区空闲态），不再出现在 JS bundle 里，
  // 所以这里改成断言 HTML 侧有这句，别再把旧 bundle 的字符串当回归基线。
  assert.match(LEDGER_HTML, /粘贴截图/);
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

// ---------------- 本轮新增：点概览条做多选筛选 ----------------

const barsOf = ($, id) => $(id).children;
const barByValue = ($, id, value) => barsOf($, id).find(bar => bar.dataset && bar.dataset.value === value);
const renderedRows = $ => { const wrap = $('rows').children[0]; return wrap ? (wrap.children || []).length : 0; };
const chipOf = ($, className) => $('activeFilters').children.find(child => typeof child.className === 'string' && child.className.includes(className));

test('点类别条筛选：点一个筛一个，再点一个变多选，取消后回到全部', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $ } = page;
  assert.equal(renderedRows($), 3, '默认不点任何东西 = 全部');

  await barByValue($, 'categoryBreakdown', '采购').fire('click', {});
  assert.equal(renderedRows($), 1, '只点「采购」→ 只剩 1 条');
  assert.equal(barByValue($, 'categoryBreakdown', '采购').getAttribute('aria-pressed'), 'true');
  assert.equal($('categoryToggle').textContent, '采购', '下拉按钮显示当前选择');
  // 关键：选中之后其它类别仍留在榜上，否则没有「多选」这回事
  assert.equal(barsOf($, 'categoryBreakdown').length, 2, '选完后另一个类别仍在榜上');

  await barByValue($, 'categoryBreakdown', '跨境电商').fire('click', {});
  assert.equal(renderedRows($), 3, '再叠「跨境电商」→ 两类都算，回到 3 条');
  assert.equal($('categoryToggle').textContent, '类别：已选 2 项');
  assert.equal($('activeFilters').hidden, false, '应出现已选条件条');
  assert.equal(chipOf($, 'ledger-chip') !== undefined, true, '应有可移除的 chip');

  await barByValue($, 'categoryBreakdown', '采购').fire('click', {});
  await barByValue($, 'categoryBreakdown', '跨境电商').fire('click', {});
  assert.equal(renderedRows($), 3, '全部取消后回到全部');
  assert.equal($('activeFilters').hidden, true, '没有已选就不显示条件条');
  assert.equal($('categoryToggle').textContent, '全部类别');
});

test('类别和项目两个维度叠加筛选（AND），chip 可单个移除、也能一键清空', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $ } = page;

  await barByValue($, 'categoryBreakdown', '跨境电商').fire('click', {});
  assert.equal(renderedRows($), 2, '类别=跨境电商 → 2 条');
  await barByValue($, 'projectBreakdown', '1060U').fire('click', {});
  assert.equal(renderedRows($), 1, '再叠加项目=1060U → 1 条');

  // chips 顺序：项目在前、类别在后
  const projectChip = chipOf($, 'ledger-chip');
  await projectChip.children[1].fire('click', {});
  assert.equal(renderedRows($), 2, '移除项目筛选后回到该类别全部');

  const clear = chipOf($, 'ledger-clear-all');
  await clear.fire('click', {});
  assert.equal(renderedRows($), 3, '清空全部 → 回到全部');
  assert.equal($('activeFilters').hidden, true);
  assert.equal($('projectToggle').textContent, '全部项目');
});

test('下拉里勾选同样能多选筛选，并和概览条状态互通', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $ } = page;
  const boxes = $('categoryOptions').children.map(child => child.children[0]);
  assert.equal(boxes.length, 2, '两个类别各一个勾选框');
  const target = boxes.find(box => box.value === '采购');
  target.checked = true;
  await target.fire('change', {});
  assert.equal(renderedRows($), 1, '勾「采购」→ 1 条');
  assert.equal($('categoryToggle').classList.contains('is-active'), true, '按钮应进入选中态');
  // 概览里对应的条也应变成已选
  assert.equal(barByValue($, 'categoryBreakdown', '采购').getAttribute('aria-pressed'), 'true');
});

test('「重置筛选」会清掉多选条件', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $ } = page;
  await barByValue($, 'categoryBreakdown', '采购').fire('click', {});
  assert.equal(renderedRows($), 1);
  await $('resetBtn').fire('click', {});
  assert.equal(renderedRows($), 3, '重置后回到全部');
  assert.equal($('categoryToggle').textContent, '全部类别');
  assert.equal($('activeFilters').hidden, true);
});

test('多选面板可开可收，Esc 收起，同时只开一个', async () => {
  const page = await bootLedgerPage({ entries: FIXTURE });
  const { $, doc } = page;
  assert.equal($('categoryPanel').hidden, true, '默认收起');
  await $('categoryToggle').fire('click', {});
  assert.equal($('categoryPanel').hidden, false);
  assert.equal($('categoryToggle').getAttribute('aria-expanded'), 'true');

  await $('projectToggle').fire('click', {});
  assert.equal($('projectPanel').hidden, false);
  assert.equal($('categoryPanel').hidden, true, '同时只开一个面板');

  await doc.fire('keydown', { key: 'Escape' });
  assert.equal($('projectPanel').hidden, true, 'Esc 收起');

  // 全选 / 清空
  await $('projectToggle').fire('click', {});
  await $('projectAll').fire('click', {});
  assert.equal(renderedRows($), 3, '全选 = 不筛');
  await $('projectNone').fire('click', {});
  assert.equal(renderedRows($), 3);
  assert.equal($('projectToggle').textContent, '全部项目');
});

test('页面标记：筛选区是多选控件而不是单选 select', () => {
  assert.match(LEDGER_HTML, /id="projectOptions"/, '项目应为多选列表');
  assert.match(LEDGER_HTML, /id="categoryOptions"/, '类别应为多选列表');
  assert.match(LEDGER_HTML, /id="activeFilters"/, '应有已选条件条');
  assert.ok(!/id="project"/.test(LEDGER_HTML), '旧的项目单选 select 应已移除');
  assert.ok(!/id="category"/.test(LEDGER_HTML), '旧的类别单选 select 应已移除');
});

// ---------------- 本轮新增：一条记录多张凭证（修「多凭证被替换」） ----------------

const lastChild = element => element.children[element.children.length - 1];

test('一次粘贴多张截图会全部保留（不再互相替换），保存时一并提交', async () => {
  const page = await bootLedgerPage();
  const { $, doc, form, calls, fieldSetters } = page;
  doc.getElementById('editDialog').open = true;
  fieldSetters.fill();

  await doc.fire('paste', makePasteEvent([pngFile(8), pngFile(16), pngFile(24)]));
  assert.equal(attachItems($).length, 3, '三张剪贴板图片都应进入待上传列表');
  assert.equal($('attachmentClearBtn').textContent, '清空已选凭证（3）', '按钮应显示张数');
  assert.match($('attachmentHint').textContent, /共 3 张/, '提示应说明一共几张');

  // 再粘一张：追加而不是替换
  await doc.fire('paste', makePasteEvent([pngFile(32)]));
  assert.equal(attachItems($).length, 4, '后续粘贴应追加');

  await form.fire('submit', { preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const post = calls.find(call => call.path === '/api/admin/costs' && call.options.method === 'POST');
  const body = JSON.parse(post.options.body);
  assert.equal(body.attachments.length, 4, '四张凭证都要进 payload');
  assert.equal(body.attachment, undefined, '不应再走单凭证字段');
  const names = body.attachments.map(item => item.name);
  assert.equal(new Set(names).size, 4, `四张凭证的文件名应各不相同，实际 ${names.join(' / ')}`);
  for (const item of body.attachments) {
    const bytes = Buffer.from(item.data, 'base64');
    assert.deepEqual([...bytes.subarray(0, 8)], PNG_HEAD, '每张都应是原始 PNG 字节');
  }
});

test('文件选择支持多选：可逐张移除，也能一键清空', async () => {
  const page = await bootLedgerPage();
  const { $, doc } = page;
  doc.getElementById('editDialog').open = true;

  const input = $('entryAttachment');
  input.files = [
    new File([new Uint8Array([...PNG_HEAD, 1])], '发票A.png', { type: 'image/png' }),
    new File([new Uint8Array([...PNG_HEAD, 2])], '发票B.png', { type: 'image/png' })
  ];
  await input.fire('change', {});
  assert.equal(attachItems($).length, 2, '多选应全部收下');
  assert.deepEqual(attachItems($).map(itemName), ['发票A.png', '发票B.png']);

  // 点第一张的「×」：只移除这一张
  await lastChild(attachItems($)[0]).fire('click', {});
  assert.deepEqual(attachItems($).map(itemName), ['发票B.png'], '只应移除被点的那一张');
  assert.equal($('attachmentPreview').hidden, false, '还剩一张时预览区仍在');

  await $('attachmentClearBtn').fire('click', {});
  assert.equal(attachItems($).length, 0, '清空按钮应清掉全部');
  assert.equal($('attachmentPreview').hidden, true);
  assert.equal($('attachmentIdle').hidden, false);
});

test('编辑已有记录：列出已有凭证，可标记删除并在保存时提交 removeAttachmentIds', async () => {
  const entry = {
    ...FIXTURE[0], version: 3,
    attachments: [
      { id: '71', name: '凭证A.png', kind: 'image' },
      { id: '72', name: '发票B.pdf', kind: 'pdf' }
    ]
  };
  const page = await bootLedgerPage({ entries: [entry] });
  const { $, doc, form, calls, fieldSetters } = page;
  await new Promise(resolve => setTimeout(resolve, 0));

  const row = $('rows').children[0].children[0];
  await lastChild(row).children[0].fire('click', {}); // 「编辑」
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(doc.getElementById('editDialog').open, true, '应打开编辑弹窗');
  assert.equal($('attachmentExisting').hidden, false, '应列出已有凭证');
  assert.match($('attachmentExisting').children[0].textContent, /已有凭证 2 张，保存后保留 2 张/);
  const chips = $('attachmentExisting').children[1].children;
  assert.equal(chips.length, 2, '两张已有凭证各一个 chip');

  // 标记删除第一张
  await lastChild(chips[0]).fire('click', {});
  assert.match($('formStatus').textContent, /已标记删除 1 张已有凭证/, '应提示保存后生效');
  const after = $('attachmentExisting').children[1].children;
  assert.equal(after.length, 2, '保留的 chip + 待删除的 chip');
  assert.ok(after.some(chip => chip.className.includes('is-removed')), '待删除的 chip 应有删除样式');

  fieldSetters.fill();
  await form.fire('submit', { preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const put = calls.find(call => call.path === '/api/admin/costs/1' && call.options.method === 'PUT');
  assert.ok(put, '应发出 PUT');
  const body = JSON.parse(put.options.body);
  assert.deepEqual(body.removeAttachmentIds, ['71'], '应提交被删除的凭证 id');
  assert.equal(body.attachments, undefined, '没选新凭证就不该带 attachments');
  assert.equal(body.version, 3, '乐观锁版本要一起带上');
});

test('凭证列：一条记录多张凭证全部出图，弹窗里可左右翻', async () => {
  const entry = {
    ...FIXTURE[0],
    attachments: [
      { id: '81', name: '凭证1.png', kind: 'image' },
      { id: '82', name: '凭证2.png', kind: 'image' },
      { id: '83', name: '凭证3.png', kind: 'image' },
      { id: '84', name: '发票4.pdf', kind: 'pdf' }
    ]
  };
  const page = await bootLedgerPage({ entries: [entry] });
  const { $, stats } = page;
  await new Promise(resolve => setTimeout(resolve, 0));

  const cell = findByClass($('rows'), 'ledger-voucher');
  const strip = findByClass(cell, 'ledger-voucher-strip');
  assert.equal(strip.children.length, 4, '前 3 张出图 + 1 个「+1」角标');
  assert.equal(lastChild(strip).textContent, '+1', '超出的张数用 +N 表示');
  assert.match(findByClass(cell, 'ledger-voucher-name').textContent, /共 4 张凭证/);
  assert.ok(lastChild(strip).className.includes('ledger-voucher-more'));
  assert.equal(stats.fetchCalls, 3, 'PDF 不需要请求二进制，另 3 张各请求一次');

  // 点第二张 → 大图弹窗停在第 2 张，且能翻页
  const thumbs = strip.children.filter(child => child.className.includes('ledger-voucher-thumb'));
  await thumbs[1].fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('voucherDialog').open, true);
  assert.equal($('voucherNav').hidden, false, '多张时应显示翻页');
  assert.equal($('voucherCounter').textContent, '第 2 / 4 张');
  assert.match($('voucherMeta').textContent, /凭证2\.png/);

  await $('voucherNextBtn').fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('voucherCounter').textContent, '第 3 / 4 张');

  // 翻到 PDF：不塞 <img>，提示下载
  await $('voucherNextBtn').fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('voucherCounter').textContent, '第 4 / 4 张');
  assert.equal($('voucherImage').hidden, true, 'PDF 不显示 <img>');
  assert.match($('voucherMeta').textContent, /PDF 无法直接预览/);

  // 再翻一张回到第 1 张（循环），ArrowLeft 往回流
  await $('voucherNextBtn').fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('voucherCounter').textContent, '第 1 / 4 张', '翻到最后应回到第一张');
  await $('voucherDialog').ownerDocument.fire('keydown', { key: 'ArrowLeft' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('voucherCounter').textContent, '第 4 / 4 张', '← 键应往前翻');

  // 单张凭证时不该出现翻页控件
  const single = await bootLedgerPage({ entries: [{ ...FIXTURE[0], attachments: [{ id: '91', name: 'only.png', kind: 'image' }] }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const onlyThumb = findByClass(single.$('rows'), 'ledger-voucher-thumb');
  await onlyThumb.fire('click', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(single.$('voucherNav').hidden, true, '只有一张时不显示翻页');
  assert.equal(single.$('voucherCounter').textContent, '');
});
