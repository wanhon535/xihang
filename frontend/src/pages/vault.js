import { setWorkspaceUser } from '../shell.js';
import { api, logout, redirectToLogin, requireUser } from '../api.js';
import { showToast } from '../ui-feedback.js';

const userName = document.querySelector('#userName');
const logoutBtn = document.querySelector('#logoutBtn');
const newCredentialBtn = document.querySelector('#newCredentialBtn');
const searchInput = document.querySelector('#vaultSearchInput');
const categoryFilterInput = document.querySelector('#categoryFilterInput');
const favoriteOnlyInput = document.querySelector('#favoriteOnlyInput');
const credentialCount = document.querySelector('#credentialCount');
const vaultTotalKeys = document.querySelector('#vaultTotalKeys');
const vaultActiveKeys = document.querySelector('#vaultActiveKeys');
const vaultExpiringKeys = document.querySelector('#vaultExpiringKeys');
const credentialList = document.querySelector('#credentialList');
const credentialForm = document.querySelector('#credentialForm');
const formTitle = document.querySelector('#formTitle');
const clearFormBtn = document.querySelector('#clearFormBtn');
const deleteCredentialBtn = document.querySelector('#deleteCredentialBtn');
const saveCredentialBtn = document.querySelector('#saveCredentialBtn');
const formStatus = document.querySelector('#formStatus');
const titleInput = document.querySelector('#credentialTitleInput');
const usernameInput = document.querySelector('#credentialUsernameInput');
const categoryInput = document.querySelector('#credentialCategoryInput');
const categoryList = document.querySelector('#categoryList');
const tagsInput = document.querySelector('#credentialTagsInput');
const passwordInput = document.querySelector('#credentialPasswordInput');
const togglePasswordInputBtn = document.querySelector('#togglePasswordInputBtn');
const generatePasswordBtn = document.querySelector('#generatePasswordBtn');
const strengthBar = document.querySelector('#strengthBar');
const strengthText = document.querySelector('#strengthText');
const urlInput = document.querySelector('#credentialUrlInput');
const notesInput = document.querySelector('#credentialNotesInput');
const favoriteInput = document.querySelector('#credentialFavoriteInput');
const generatorLengthInput = document.querySelector('#generatorLengthInput');
const generatorLengthText = document.querySelector('#generatorLengthText');
const generatorUpperInput = document.querySelector('#generatorUpperInput');
const generatorLowerInput = document.querySelector('#generatorLowerInput');
const generatorNumberInput = document.querySelector('#generatorNumberInput');
const generatorSymbolInput = document.querySelector('#generatorSymbolInput');
const applyGeneratedPasswordBtn = document.querySelector('#applyGeneratedPasswordBtn');
const copyGeneratedPasswordBtn = document.querySelector('#copyGeneratedPasswordBtn');
const generatedPasswordPreview = document.querySelector('#generatedPasswordPreview');

const charSets = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  number: '23456789',
  symbol: '!@#$%^&*()-_=+[]{}:,.?'
};

let credentials = [];
let editingId = null;
let lastGeneratedPassword = '';

logoutBtn.addEventListener('click', logout);
const credentialDialog = document.querySelector('#create-key-modal');
function openCredentialEditor() {
  if (!credentialDialog.open) credentialDialog.showModal();
}
newCredentialBtn.addEventListener('click', () => { startCreate(); openCredentialEditor(); });
function clearEditorSecret() { passwordInput.value = ''; passwordInput.type = 'password'; }
document.querySelector('#closeCredentialBtn').addEventListener('click', () => { clearEditorSecret(); credentialDialog.close(); });
credentialDialog.addEventListener('cancel', clearEditorSecret);
credentialDialog.addEventListener('close', clearEditorSecret);
clearFormBtn.addEventListener('click', startCreate);
deleteCredentialBtn.addEventListener('click', deleteCurrentCredential);
searchInput.addEventListener('input', renderCredentials);
categoryFilterInput.addEventListener('change', renderCredentials);
favoriteOnlyInput.addEventListener('change', renderCredentials);
credentialForm.addEventListener('submit', saveCredential);
passwordInput.addEventListener('input', updateStrength);
togglePasswordInputBtn.addEventListener('click', togglePasswordInput);
generatePasswordBtn.addEventListener('click', applyGeneratedPassword);
generatorLengthInput.addEventListener('input', updateGeneratorPreview);
generatorUpperInput.addEventListener('change', updateGeneratorPreview);
generatorLowerInput.addEventListener('change', updateGeneratorPreview);
generatorNumberInput.addEventListener('change', updateGeneratorPreview);
generatorSymbolInput.addEventListener('change', updateGeneratorPreview);
applyGeneratedPasswordBtn.addEventListener('click', applyGeneratedPassword);
copyGeneratedPasswordBtn.addEventListener('click', copyGeneratedPassword);

init();

async function init() {
  try {
    const user = await requireUser();
    if (!user) {
      return;
    }

    setWorkspaceUser(user);
    userName.textContent = user.nick || user.username || '汐航用户';
    document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', user.role !== 'admin'));
    startCreate();
    updateGeneratorPreview();
    await loadCredentials();
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    renderListMessage(error.message);
  }
}

async function loadCredentials() {
  const payload = await api('/api/vault/credentials');
  credentials = payload.credentials || [];
  credentialCount.textContent = `${credentials.length} 条记录`;
  if (vaultTotalKeys) {
    vaultTotalKeys.textContent = String(credentials.length);
  }
  if (vaultActiveKeys) {
    vaultActiveKeys.textContent = String(getCategories().length);
  }
  if (vaultExpiringKeys) {
    vaultExpiringKeys.textContent = String(credentials.filter(item => item.isFavorite).length);
  }
  renderCategoryOptions();
  renderCredentials();
}

function renderCategoryOptions() {
  const categories = getCategories();
  const selected = categoryFilterInput.value;

  categoryFilterInput.innerHTML = '<option value="">全部项目/系统</option>';
  categoryList.innerHTML = '';

  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    categoryFilterInput.appendChild(option);

    const dataOption = document.createElement('option');
    dataOption.value = category;
    categoryList.appendChild(dataOption);
  });

  if (categories.includes(selected)) {
    categoryFilterInput.value = selected;
  }
}

function renderCredentials() {
  const visibleCredentials = getVisibleCredentials();
  credentialCount.textContent = `${visibleCredentials.length} / ${credentials.length} 条记录`;

  credentialList.innerHTML = '';

  if (visibleCredentials.length === 0) {
    renderListMessage(credentials.length === 0 ? '这里还空着。先新增一个项目或系统相关的凭证，它会只属于你。' : '没有匹配的项目凭证，换个项目名、账号、网址或 IP 试试。');
    return;
  }

  getProjectGroups(visibleCredentials).forEach((group) => {
    const section = el('section', 'credential-group');
    const head = el('div', 'credential-group-head');
    head.append(el('strong', '', group.name), el('span', '', `${group.items.length} 条凭证`));

    const body = el('div', 'credential-group-body');
    group.items.forEach((credential) => {
      body.appendChild(renderCredentialCard(credential));
    });

    section.append(head, body);
    credentialList.appendChild(section);
  });
}

function getVisibleCredentials() {
  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilterInput.value;
  const favoriteOnly = favoriteOnlyInput.checked;

  return credentials.filter((credential) => {
    if (category && credential.category !== category) {
      return false;
    }

    if (favoriteOnly && !credential.isFavorite) {
      return false;
    }

    if (!query) {
      return true;
    }

    return [
      credential.title,
      credential.loginUsername,
      credential.category,
      credential.url,
      credential.notes,
      ...(credential.tags || [])
    ]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

function getProjectGroups(items) {
  const groupMap = new Map();
  items.forEach((item) => {
    const name = item.category || '默认项目';
    if (!groupMap.has(name)) {
      groupMap.set(name, []);
    }
    groupMap.get(name).push(item);
  });

  return [...groupMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([name, groupItems]) => ({
      name,
      items: groupItems.sort((left, right) => String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN'))
    }));
}

function renderCredentialCard(credential) {
  const card = el('article', 'credential-card');
  card.classList.toggle('selected', credential.id === editingId);

  const main = el('div', 'credential-main');
  const badge = el('div', 'credential-badge', getInitial(credential.category || credential.title));
  const content = el('div', 'credential-content');
  const titleRow = el('div', 'credential-title-row');
  const title = el('strong', '', credential.title);
  const favorite = el('span', credential.isFavorite ? 'favorite-mark active' : 'favorite-mark', credential.isFavorite ? '常用' : '未收藏');
  titleRow.append(title, favorite);

  const meta = el('div', 'credential-meta');
  meta.append(
    el('span', '', `项目 ${credential.category || '未归档'}`),
    el('span', '', `账号 ${credential.loginUsername || '未填写'}`),
    el('span', '', `地址 ${credential.url ? getDisplayEndpoint(credential.url) : '未填写'}`),
    el('span', '', `更新 ${formatDate(credential.updatedAt)}`)
  );

  const tagLine = el('div', 'tags credential-tags');
  tagLine.append(el('b', '', credential.category || '默认项目'));
  (credential.tags || []).forEach((tag) => tagLine.append(el('b', '', tag)));
  content.append(titleRow, tagLine);
  main.append(badge, content);

  const actions = el('div', 'credential-actions');
  const editBtn = button('plain-btn small', '编辑');
  const copyUserBtn = button('plain-btn small icon-action', '账号');
  copyUserBtn.title = '复制账号';
  const copyPasswordBtn = button('plain-btn small icon-action', '密码');
  copyPasswordBtn.title = '复制密码';
  const revealBtn = button('plain-btn small icon-action', '查看');
  revealBtn.title = '显示密码';
  const openBtn = button('plain-btn small icon-action', '打开');
  openBtn.title = '打开网址或 IP';
  openBtn.disabled = !credential.url;

  const secretBox = el('div', 'secret-box hidden');
  const secretLabel = el('span', '', '状态');
  const secretValue = el('code', '', '');
  secretBox.append(secretLabel, secretValue);

  editBtn.addEventListener('click', () => editCredential(credential.id));
  copyUserBtn.addEventListener('click', async () => {
    try {
      if (!credential.loginUsername) {
        setInlineStatus(secretValue, '这条记录还没有填写账号');
        secretBox.classList.remove('hidden');
        return;
      }
      await copyText(credential.loginUsername);
      showToast('已添加到剪贴板', copyUserBtn);
      setInlineStatus(secretValue, '账号已复制');
      secretBox.classList.remove('hidden');
    } catch (error) {
      showToast(error.message || '复制失败', copyUserBtn);
      setInlineStatus(secretValue, error.message || '复制失败');
      secretBox.classList.remove('hidden');
    }
  });
  copyPasswordBtn.addEventListener('click', async () => {
    try {
      const password = await fetchPassword(credential.id);
      await copyText(password);
      showToast('已添加到剪贴板', copyPasswordBtn);
      setInlineStatus(secretValue, '密码已复制');
      secretBox.classList.remove('hidden');
    } catch (error) {
      showToast(error.message || '复制失败', copyPasswordBtn);
      setInlineStatus(secretValue, error.message || '复制失败');
      secretBox.classList.remove('hidden');
    }
  });
  revealBtn.addEventListener('click', async () => {
    try {
      if (secretBox.dataset.loaded !== 'true') {
        secretValue.textContent = await fetchPassword(credential.id);
        secretBox.dataset.loaded = 'true';
      }

      const shouldHide = !secretBox.classList.contains('hidden');
      secretBox.classList.toggle('hidden', shouldHide);
      secretLabel.textContent = shouldHide ? '状态' : '密码';
      revealBtn.textContent = shouldHide ? '显示' : '隐藏';
    } catch (error) {
      setInlineStatus(secretValue, error.message || '读取失败');
      secretBox.classList.remove('hidden');
    }
  });
  openBtn.addEventListener('click', () => {
    if (credential.url) {
      window.open(normalizeOpenUrl(credential.url), '_blank', 'noopener,noreferrer');
    }
  });

  actions.append(editBtn, copyUserBtn, copyPasswordBtn, revealBtn, openBtn);
  card.append(main, meta, actions, secretBox);

  return card;
}

function renderListMessage(message) {
  credentialList.innerHTML = '';
  credentialList.appendChild(el('div', 'empty-card compact', message));
}

function startCreate() {
  editingId = null;
  credentialForm.reset();
  formTitle.textContent = '新增记录';
  passwordInput.required = true;
  passwordInput.type = 'password';
  passwordInput.placeholder = '保存这个账号的密码';
  togglePasswordInputBtn.textContent = '显示';
  deleteCredentialBtn.classList.add('hidden');
  categoryInput.value = categoryFilterInput.value || '默认项目';
  formStatus.textContent = '';
  updateStrength();
  renderCredentials();
}

function editCredential(id) {
  const credential = credentials.find((item) => item.id === id);
  if (!credential) {
    return;
  }

  editingId = id;
  openCredentialEditor();
  formTitle.textContent = '编辑记录';
  titleInput.value = credential.title || '';
  usernameInput.value = credential.loginUsername || '';
  categoryInput.value = credential.category || '默认项目';
  tagsInput.value = (credential.tags || []).join('，');
  passwordInput.value = '';
  passwordInput.type = 'password';
  passwordInput.required = false;
  passwordInput.placeholder = '留空则保持原密码';
  togglePasswordInputBtn.textContent = '显示';
  urlInput.value = credential.url || '';
  notesInput.value = credential.notes || '';
  favoriteInput.checked = Boolean(credential.isFavorite);
  deleteCredentialBtn.classList.remove('hidden');
  formStatus.textContent = '';
  updateStrength();
  renderCredentials();
}

async function saveCredential(event) {
  event.preventDefault();
  saveCredentialBtn.disabled = true;
  formStatus.textContent = '正在保存...';

  try {
    const body = {
      title: titleInput.value,
      loginUsername: usernameInput.value,
      category: categoryInput.value,
      tags: tagsInput.value,
      isFavorite: favoriteInput.checked,
      url: urlInput.value,
      notes: notesInput.value
    };

    if (!editingId || passwordInput.value) {
      body.password = passwordInput.value;
    }

    const payload = editingId
      ? await api(`/api/vault/credentials/${editingId}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('/api/vault/credentials', { method: 'POST', body: JSON.stringify(body) });

    editingId = payload.credential.id;
    await loadCredentials();
    editCredential(editingId);
    formStatus.textContent = '已保存到你的星钥库。';
  } catch (error) {
    formStatus.textContent = error.message;
  } finally {
    saveCredentialBtn.disabled = false;
  }
}

async function deleteCurrentCredential() {
  if (!editingId || !window.confirm('确认删除这条账号记录？')) {
    return;
  }

  deleteCredentialBtn.disabled = true;
  formStatus.textContent = '正在删除...';

  try {
    await api(`/api/vault/credentials/${editingId}`, { method: 'DELETE' });
    await loadCredentials();
    startCreate();
    formStatus.textContent = '已删除这条记录。';
  } catch (error) {
    formStatus.textContent = error.message;
  } finally {
    deleteCredentialBtn.disabled = false;
  }
}

async function fetchPassword(id) {
  const payload = await api(`/api/vault/credentials/${id}/secret`);
  return payload.secret.password;
}

function togglePasswordInput() {
  const shouldShow = passwordInput.type === 'password';
  passwordInput.type = shouldShow ? 'text' : 'password';
  togglePasswordInputBtn.textContent = shouldShow ? '隐藏' : '显示';
}

function updateStrength() {
  const score = scorePassword(passwordInput.value);
  const labels = ['未填写', '较弱', '可用', '稳妥', '很强'];
  strengthBar.dataset.score = String(score);
  strengthText.textContent = labels[score];
}

function scorePassword(value) {
  if (!value) {
    return 0;
  }

  let score = value.length >= 12 ? 1 : 0;
  if (value.length >= 16) {
    score += 1;
  }
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) {
    score += 1;
  }
  if (/\d/.test(value)) {
    score += 1;
  }
  if (/[^A-Za-z0-9]/.test(value)) {
    score += 1;
  }

  return Math.min(score, 4);
}

function updateGeneratorPreview() {
  generatorLengthText.textContent = `${generatorLengthInput.value} 位`;
  lastGeneratedPassword = generatePassword();
  generatedPasswordPreview.textContent = lastGeneratedPassword;
}

function applyGeneratedPassword() {
  updateGeneratorPreview();
  passwordInput.value = lastGeneratedPassword;
  passwordInput.type = 'text';
  togglePasswordInputBtn.textContent = '隐藏';
  updateStrength();
}

async function copyGeneratedPassword() {
  try {
    updateGeneratorPreview();
    await copyText(lastGeneratedPassword);
    showToast('已添加到剪贴板', copyGeneratedPasswordBtn);
    formStatus.textContent = '生成密码已复制。';
  } catch (error) {
    showToast(error.message || '复制失败', copyGeneratedPasswordBtn);
    formStatus.textContent = error.message || '复制失败。';
  }
}

function generatePassword() {
  const enabledSets = [
    generatorUpperInput.checked ? charSets.upper : '',
    generatorLowerInput.checked ? charSets.lower : '',
    generatorNumberInput.checked ? charSets.number : '',
    generatorSymbolInput.checked ? charSets.symbol : ''
  ].filter(Boolean);

  if (enabledSets.length === 0) {
    generatorLowerInput.checked = true;
    enabledSets.push(charSets.lower);
  }

  const length = Number(generatorLengthInput.value);
  const chars = enabledSets.join('');
  const password = enabledSets.map((set) => pickRandom(set));

  while (password.length < length) {
    password.push(pickRandom(chars));
  }

  return shuffle(password).join('');
}

function pickRandom(chars) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return chars[values[0] % chars.length];
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    const swapIndex = values[0] % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function setInlineStatus(node, text) {
  node.textContent = text;
  window.setTimeout(() => {
    if (node.textContent === text) {
      node.textContent = '';
    }
  }, 1800);
}

function getCategories() {
  return [...new Set(credentials.map((credential) => credential.category || '默认项目'))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN')
  );
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(className, text) {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function getHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function getDisplayEndpoint(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function normalizeOpenUrl(value) {
  const text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return `http://${text}`;
}

function getInitial(value = '') {
  return String(value).trim().slice(0, 1).toUpperCase() || '钥';
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

