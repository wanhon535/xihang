import { setWorkspaceUser } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';

const $ = id => document.getElementById(id);
let docs = [];
let user = null;

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
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
function render() {
  const keyword = $('searchInput').value.trim().toLowerCase();
  const visible = keyword
    ? docs.filter(doc => (doc.name || '').toLowerCase().includes(keyword) || (doc.workspaceName || '').toLowerCase().includes(keyword))
    : docs;
  $('docCount').textContent = `${visible.length} / ${docs.length} 篇`;
  const list = $('docList');
  if (!visible.length) {
    list.replaceChildren(node('div', docs.length ? '没有符合搜索条件的文档。' : '还没有同步任何知识库文档，请联系管理员在管理中枢 → 人员同步里同步。', 'empty-card'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const doc of visible) {
    const row = node('article', undefined, 'audit-row');
    const main = node('div');
    main.append(node('strong', doc.name || '未命名文档'), node('span', doc.workspaceName || ''));
    const side = node('div');
    const link = document.createElement('a');
    link.href = doc.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '在钉钉中打开';
    side.append(link, node('small', formatDate(doc.modifiedTime)));
    row.append(main, side);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
}
async function load() {
  status('正在加载知识库文档…');
  $('refreshBtn').disabled = true;
  try {
    const payload = await api('/api/knowledge-base');
    docs = payload.docs || [];
    render();
    status('');
  } catch (error) {
    if (error.status === 401) { redirectToLogin('登录已失效，请重新登录。'); return; }
    status(`加载失败：${error.message}`, true);
  } finally {
    $('refreshBtn').disabled = false;
  }
}
$('searchInput').addEventListener('input', render);
$('refreshBtn').addEventListener('click', load);
$('logoutBtn').addEventListener('click', async () => {
  try { await logout(); } catch (error) { if (error.status !== 401) status(`退出失败：${error.message}`, true); }
});

async function init() {
  try {
    user = await requireUser();
    if (!user) return;
    setWorkspaceUser(user);
    $('userName').textContent = user.nick || user.username || '成员';
    $('knowledgeWorkspace').hidden = false;
    await load();
  } catch (error) {
    status(`身份验证失败：${error.message}`, true);
  }
}
init();
