// 站点矩阵页面级回归测试：用极简 DOM stub 跑**真实的** frontend/src/pages/admin.js，
// 复现用户报的「新增入口保存了、但没展示 / 怎么填都存不上」。
//
// 关键：api stub 必须**忠实模拟后端**（PUT 会丢掉缺 name/url 的入口，并返回权威副本），
// 否则复现不了：老实现 `groups = payload.groups` 正是在这个响应上把本地卡片变成孤儿对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  buildSavePayload,
  commitSavePayload,
  createSiteMatrixState,
  pendingSummary,
  primeSiteMatrixState
} from '../frontend/src/site-matrix.js';

// ---------------- 极简 DOM stub ----------------
const makeClassList = () => {
  const set = new Set();
  return {
    add: (...names) => names.forEach((name) => set.add(name)),
    remove: (...names) => names.forEach((name) => set.delete(name)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
      return on;
    }
  };
};

const makeElement = (tag) => {
  const listeners = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    hidden: false,
    disabled: false,
    open: false,
    textContent: '',
    className: '',
    placeholder: '',
    rows: 0,
    dataset: {},
    style: {},
    files: [],
    _value: '',
    _attributes: {},
    get value() { return this._value; },
    set value(next) { this._value = next === undefined || next === null ? '' : String(next); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    fire(type, event) {
      return Promise.all([...(listeners.get(type) || [])].map((handler) => handler(event || {})));
    },
    listenerCount: (type) => (listeners.get(type) || []).length,
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    remove() {},
    focus() {},
    click() {},
    setAttribute(name, value) { this._attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null; },
    removeAttribute(name) { delete this._attributes[name]; },
    reportValidity() { return true; },
    closest() { return null; },
    querySelector() { return null; },
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
  element.classList = makeClassList();
  // 真实 DOM 里给 innerHTML 赋值会**替换全部子节点**。stub 必须照做，
  // 否则 admin.js 的 `editor.innerHTML = ''`（renderGroups 开头）清不掉旧卡片，
  // 测试会数出重复的入口卡片（第一次就踩了）。
  let innerHTMLValue = '';
  Object.defineProperty(element, 'innerHTML', {
    get() { return innerHTMLValue; },
    set(value) { innerHTMLValue = String(value); element.children = []; }
  });
  return element;
};

const makeDocument = () => {
  const cache = new Map();
  const listeners = new Map();
  const doc = {
    createElement: (tag) => makeElement(tag),
    createDocumentFragment: () => makeElement('fragment'),
    body: makeElement('body'),
    getElementById(id) { return doc.querySelector(`#${id}`); },
    querySelector(selector) {
      if (!cache.has(selector)) {
        const element = makeElement('div');
        element._selector = selector;
        cache.set(selector, element);
      }
      return cache.get(selector);
    },
    // 面板/触发器列表用不到，返回空数组即可（showPanel 会安全早退）
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    fire(type, event) { return Promise.all([...(listeners.get(type) || [])].map((h) => h(event || {}))); }
  };
  doc.cache = cache;
  return doc;
};

// 深度遍历 stub 树找元素
const walk = (root, visit) => {
  for (const child of root.children || []) {
    if (visit(child)) return child;
    const hit = walk(child, visit);
    if (hit) return hit;
  }
  return null;
};
const findByText = (root, text) => walk(root, (node) => node.textContent === text);
const findInputByPlaceholder = (root, placeholder) => walk(root, (node) => node.placeholder === placeholder
  && String(node.tagName).toLowerCase() === 'input');

// 按顺序取出所有「入口卡片」（details.site-editor）。
// ⚠️ 别用 placeholder 全局找输入框：每个入口卡片用的 placeholder 都一样，
// 第一次写测试就抓成了第一个入口的框，测出一个假失败。
const siteCardsOf = (editor) => {
  const cards = [];
  for (const groupCard of editor.children || []) {
    const list = (groupCard.children || []).find((node) => node.className === 'site-editor-list');
    if (list) cards.push(...list.children);
  }
  return cards;
};
const cardFields = (card) => ({
  name: findInputByPlaceholder(card, '例如：运营后台'),
  url: findInputByPlaceholder(card, 'https://...'),
  icon: findInputByPlaceholder(card, 'https://.../favicon.png')
});

// ---------------- 把真实页面模块跑起来 ----------------
const INITIAL_GROUPS = () => ([
  {
    id: 105,
    name: '核心业务',
    description: '日常业务',
    sites: [
      { id: 782, name: '主站', url: 'https://a.com', iconUrl: '', description: '', tags: ['业务'], visibility: 'all', allowedRoles: [], allowedUserIds: [] },
      { id: 783, name: '备用站', url: 'https://b.com', iconUrl: '', description: '', tags: [], visibility: 'all', allowedRoles: [], allowedUserIds: [] }
    ]
  }
]);

const bootAdminPage = async () => {
  const doc = makeDocument();
  const calls = [];
  let putCount = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    const method = options.method || 'GET';
    if (path === '/api/admin/groups' && method === 'GET') {
      return { ok: true, groups: INITIAL_GROUPS() };
    }
    if (path === '/api/admin/groups' && method === 'PUT') {
      const sent = JSON.parse(options.body).groups;
      putCount += 1;
      // 忠实模拟后端：过滤无 name/url 的入口、丢弃未命名分组，并整体重插（id 全换）
      const canonical = sent
        .map((group, groupIndex) => ({
          id: 300 + groupIndex,
          name: group.name,
          description: group.description,
          sites: (group.sites || [])
            .filter((site) => String(site.name || '').trim() && String(site.url || '').trim())
            .map((site, siteIndex) => ({ ...site, id: 900 + putCount * 100 + siteIndex }))
        }))
        .filter((group) => group.name);
      return { ok: true, groups: canonical };
    }
    if (path === '/api/admin/overview') return { ok: true, overview: {} };
    if (path === '/api/admin/users') return { ok: true, users: [] };
    if (path === '/api/admin/settings') return { ok: true, settings: {} };
    if (path === '/api/admin/audit-logs') return { ok: true, logs: [] };
    if (path === '/api/admin/projects') return { ok: true, projects: [] };
    return { ok: true };
  };

  const localStorageStore = new Map();
  const context = vm.createContext({
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    JSON,
    btoa,
    atob,
    siteStateHolder: {},
    // import 行被剥掉，注入被引用的依赖（真实实现）
    buildSavePayload,
    commitSavePayload,
    createSiteMatrixState,
    pendingSummary,
    primeSiteMatrixState,
    localStorage: {
      getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
      setItem: (key, value) => localStorageStore.set(key, String(value)),
      removeItem: (key) => localStorageStore.delete(key)
    },
    window: {
      location: { hash: '', href: '', pathname: '/admin.html', origin: 'http://localhost' },
      addEventListener: () => {},
      confirm: () => true,
      prompt: () => ''
    },
    api,
    requireUser: async () => ({ id: '1', username: 'admin', nick: '管理员', role: 'admin' }),
    setWorkspaceUser: () => {},
    syncActiveHeading: () => {},
    setNotifications: () => {},
    showToast: () => {},
    closeDialogAnimated: () => {},
    logout: async () => {},
    redirectToLogin: () => {}
  });

  const source = readFileSync('frontend/src/pages/admin.js', 'utf8').replace(/^import .*$/gm, '');
  vm.runInContext(source, context, { filename: 'admin.js' });
  await new Promise((resolve) => setTimeout(resolve, 0)); // 等 init() 的 await 链落定

  return {
    doc,
    calls,
    putPayloads: () => calls.filter((c) => c.options.method === 'PUT').map((c) => JSON.parse(c.options.body).groups),
    editor: doc.querySelector('#adminEditor'),
    saveStatus: doc.querySelector('#saveStatus'),
    $: (id) => doc.querySelector(`#${id}`)
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('页面级回归：新增入口 → 自动保存 → 填内容 → 内容必须真的进 payload（老实现会丢）', async () => {
  const page = await bootAdminPage();
  const { editor, saveStatus, putPayloads } = page;
  const cards = () => siteCardsOf(editor);

  assert.equal(cards().length, 2, '初始应有 2 个已有入口');

  // 1) 点「新增入口」（用户动作）
  await findByText(editor, '新增入口').fire('click', {});
  await sleep(1100); // 等自动保存的 900ms 防抖

  assert.equal(putPayloads().length, 0, '新入口还没填内容，不应提交（避免无意义全表重建 + 谎报已保存）');
  assert.match(saveStatus.textContent, /还没填「名称 \+ 访问地址」/, '状态栏要如实说明为什么没入库');
  assert.equal(cards().length, 3, '新入口卡片必须留在界面上让用户继续填');

  // 2) 用户往**新入口**里填名称和地址（必须写进真正参与保存的那个对象）
  const { name, url } = cardFields(cards()[2]);
  assert.ok(name && url, '新入口卡片里应有名称/地址输入框');
  name.value = '新后台';
  await name.fire('input', {});
  url.value = 'https://new.example.com';
  await url.fire('input', {});
  await sleep(1100);

  const first = putPayloads();
  assert.equal(first.length, 1, '填完后应提交一次');
  assert.equal(first[0][0].sites.length, 3, 'payload 里必须包含新增的入口');
  assert.equal(first[0][0].sites[2].name, '新后台');
  assert.equal(first[0][0].sites[2].url, 'https://new.example.com');

  // 3) 保存成功后，服务端返回「过滤后的权威副本」（id 全换）。老实现正是在这里
  //    执行 groups = payload.groups，把本地对象整体换掉 → 下面这次修改永远进不了 payload。
  const after = cardFields(cards()[2]);
  after.url.value = 'https://new2.example.com';
  await after.url.fire('input', {});
  await sleep(1100);

  const second = putPayloads();
  assert.equal(second.length, 2, '改地址后应再提交一次');
  const sites = second[1][0].sites;
  assert.equal(sites.length, 3, '新增的入口不能因为服务端返回副本而消失');
  assert.equal(sites[2].url, 'https://new2.example.com', '保存后的再次编辑必须能写进 payload');
});

test('页面级回归：自动保存之后再改已有入口，改动同样不能丢', async () => {
  const page = await bootAdminPage();
  const { editor, putPayloads } = page;
  const cards = () => siteCardsOf(editor);

  // 第一次改动：改已有入口「主站」的名称
  const first = cardFields(cards()[0]).name;
  assert.equal(first.value, '主站');
  first.value = '主站（新）';
  await first.fire('input', {});
  await sleep(1100);
  assert.equal(putPayloads().length, 1);

  // 第二次改动：老实现在上一次自动保存后把对象换成服务端副本，这次输入会丢
  const again = cardFields(cards()[0]).name;
  assert.equal(again.value, '主站（新）', '自动保存不应重建 DOM、也不该回滚用户输入');
  again.value = '主站（最终）';
  await again.fire('input', {});
  await sleep(1100);

  const payloads = putPayloads();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1][0].sites[0].name, '主站（最终）', '第二次改动必须进 payload');
  assert.equal(payloads[1][0].sites[0].id, undefined, '本地对象不该被服务端副本整条替换（应以本地为准）');
});

test('页面级：未填完的入口不会跟着一起提交，但也不会从界面消失', async () => {
  const page = await bootAdminPage();
  const { editor, saveStatus, putPayloads } = page;
  const cards = () => siteCardsOf(editor);

  await findByText(editor, '新增入口').fire('click', {});
  // 新入口只填名称、不填地址
  const { name } = cardFields(cards()[2]);
  name.value = '半成品';
  await name.fire('input', {});
  // 同时改一个已有入口，确保这次确实会提交
  const mainName = cardFields(cards()[0]).name;
  mainName.value = '主站X';
  await mainName.fire('input', {});
  await sleep(1100);

  const payloads = putPayloads();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0][0].sites.length, 2, '只提交填完的两个，半成品不入库');
  assert.ok(payloads[0][0].sites.every((site) => site.name !== '半成品'));
  assert.equal(cards().length, 3, '半成品卡片必须还留在界面上，让用户接着填');
  assert.match(saveStatus.textContent, /还没填「名称 \+ 访问地址」/, '要提示用户它还没入库');
});
