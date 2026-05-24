import { api, createSsoUrl, logout, redirectToLogin, requireUser } from '../api.js';
import { API_BASE_URL } from '../config.js';

const content = document.querySelector('#content');
const userName = document.querySelector('#userName');
const accountName = document.querySelector('#accountName');
const accountRole = document.querySelector('#accountRole');
const groupCount = document.querySelector('#groupCount');
const siteCount = document.querySelector('#siteCount');
const keyCount = document.querySelector('#keyCount');
const visitCount = document.querySelector('#visitCount');
const directorySummary = document.querySelector('#directorySummary');
const searchInput = document.querySelector('#searchInput');
const logoutBtn = document.querySelector('#logoutBtn');
const themeToggleBtn = document.querySelector('#themeToggleBtn');
const workspaceThemePanel = document.querySelector('#workspaceThemePanel');
const themePanelCloseBtn = document.querySelector('#themePanelCloseBtn');
const themeModeInput = document.querySelector('#workspaceThemeModeInput');
const solidColorInput = document.querySelector('#workspaceSolidColorInput');
const gradientStartInput = document.querySelector('#workspaceGradientStartInput');
const gradientEndInput = document.querySelector('#workspaceGradientEndInput');
const gradientAngleInput = document.querySelector('#workspaceGradientAngleInput');
const overlayInput = document.querySelector('#workspaceOverlayInput');
const backgroundInput = document.querySelector('#workspaceBackgroundInput');
const themePreview = document.querySelector('#workspaceThemePreview');
const themeSaveBtn = document.querySelector('#themeSaveBtn');
const themeResetBtn = document.querySelector('#themeResetBtn');
const themeStatus = document.querySelector('#themeStatus');
let allGroups = [];
let currentTheme = getDefaultTheme();

const THEME_STORAGE_KEY = 'xihang.workspace.theme';
const THEME_PRESETS = {
  deep: {
    mode: 'gradient',
    solidColor: '#08090a',
    gradientStart: '#08090a',
    gradientEnd: '#0f2f2b',
    gradientAngle: 135,
    overlay: 28
  },
  aurora: {
    mode: 'gradient',
    solidColor: '#090b16',
    gradientStart: '#111827',
    gradientEnd: '#4f46e5',
    gradientAngle: 128,
    overlay: 34
  },
  graphite: {
    mode: 'gradient',
    solidColor: '#0b0d12',
    gradientStart: '#101214',
    gradientEnd: '#2f343b',
    gradientAngle: 145,
    overlay: 22
  }
};

const cachedTheme = readCachedTheme();
if (cachedTheme) {
  currentTheme = cachedTheme;
  applyWorkspaceTheme(currentTheme);
}

logoutBtn.addEventListener('click', logout);
searchInput.addEventListener('input', () => {
  const groups = filterGroups(allGroups, searchInput.value);
  renderGroups(groups);
  updateDirectorySummary(groups, searchInput.value);
});
themeToggleBtn?.addEventListener('click', () => {
  workspaceThemePanel?.classList.toggle('hidden');
});
themePanelCloseBtn?.addEventListener('click', () => {
  workspaceThemePanel?.classList.add('hidden');
});
[themeModeInput, solidColorInput, gradientStartInput, gradientEndInput, gradientAngleInput, overlayInput].forEach((input) => {
  input?.addEventListener('input', previewWorkspaceThemeFromForm);
  input?.addEventListener('change', previewWorkspaceThemeFromForm);
});
backgroundInput?.addEventListener('change', uploadWorkspaceBackground);
themeSaveBtn?.addEventListener('click', saveWorkspaceTheme);
themeResetBtn?.addEventListener('click', resetWorkspaceTheme);
document.querySelectorAll('[data-theme-preset]').forEach((button) => {
  button.addEventListener('click', () => applyThemePreset(button.dataset.themePreset));
});

init();

async function init() {
  try {
    const user = await requireUser();
    if (!user) {
      return;
    }

    const displayName = user.nick || user.username || '汐航用户';
    userName.textContent = displayName;
    accountName.textContent = displayName;
    accountRole.textContent = user.role === 'admin' ? '管理员' : '普通成员';
    document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', user.role !== 'admin'));
    await loadWorkspaceTheme();

    const payload = await api('/api/nav/groups');
    allGroups = payload.groups || [];
    groupCount.textContent = allGroups.length;
    siteCount.textContent = countSites(allGroups);
    visitCount.textContent = String(Math.min(countSites(allGroups), 12));
    loadKeyCount();
    renderGroups(allGroups);
    updateDirectorySummary(allGroups, '');
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    content.className = 'workspace-empty';
    content.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

async function loadWorkspaceTheme() {
  setThemeForm(currentTheme);

  try {
    const payload = await api('/api/user/workspace-theme');
    currentTheme = normalizeTheme(payload.theme);
    setThemeForm(currentTheme);
    applyWorkspaceTheme(currentTheme);
    cacheTheme(currentTheme);
  } catch (error) {
    themeStatus.textContent = error.message || '外观配置读取失败，已使用本地缓存。';
  }
}

async function saveWorkspaceTheme() {
  currentTheme = readThemeForm();
  applyWorkspaceTheme(currentTheme);
  themeSaveBtn.disabled = true;
  themeStatus.textContent = '正在保存外观...';

  try {
    const payload = await api('/api/user/workspace-theme', {
      method: 'PUT',
      body: JSON.stringify({ theme: currentTheme })
    });
    currentTheme = normalizeTheme(payload.theme);
    setThemeForm(currentTheme);
    applyWorkspaceTheme(currentTheme);
    cacheTheme(currentTheme);
    themeStatus.textContent = '外观已保存，只会应用到你的账号。';
  } catch (error) {
    themeStatus.textContent = error.message;
  } finally {
    themeSaveBtn.disabled = false;
  }
}

function resetWorkspaceTheme() {
  currentTheme = getDefaultTheme();
  setThemeForm(currentTheme);
  applyWorkspaceTheme(currentTheme);
  themeStatus.textContent = '已恢复默认外观，保存后生效到你的账号。';
}

function applyThemePreset(name) {
  const preset = THEME_PRESETS[name];
  if (!preset) {
    return;
  }

  currentTheme = normalizeTheme({ ...currentTheme, ...preset, imageUrl: currentTheme.imageUrl });
  setThemeForm(currentTheme);
  applyWorkspaceTheme(currentTheme);
  themeStatus.textContent = '已套用预设，保存后生效到你的账号。';
}

function previewWorkspaceThemeFromForm() {
  currentTheme = readThemeForm();
  applyWorkspaceTheme(currentTheme);
  themeStatus.textContent = '';
}

async function uploadWorkspaceBackground() {
  const file = backgroundInput.files?.[0];
  if (!file) {
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    themeStatus.textContent = '背景图片不能超过 5MB。';
    backgroundInput.value = '';
    return;
  }

  backgroundInput.disabled = true;
  themeStatus.textContent = '正在上传背景图...';

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const payload = await api('/api/user/workspace-theme/background', {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        dataUrl
      })
    });
    currentTheme = normalizeTheme({ ...readThemeForm(), mode: 'image', imageUrl: payload.image.imageUrl });
    setThemeForm(currentTheme);
    applyWorkspaceTheme(currentTheme);
    themeStatus.textContent = '背景图已上传，点击“保存外观”后会固定到你的账号。';
  } catch (error) {
    themeStatus.textContent = error.message;
  } finally {
    backgroundInput.disabled = false;
    backgroundInput.value = '';
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(new Error('背景图片读取失败。')));
    reader.readAsDataURL(file);
  });
}

function setThemeForm(theme) {
  const normalized = normalizeTheme(theme);
  themeModeInput.value = normalized.mode;
  solidColorInput.value = normalized.solidColor;
  gradientStartInput.value = normalized.gradientStart;
  gradientEndInput.value = normalized.gradientEnd;
  gradientAngleInput.value = String(normalized.gradientAngle);
  overlayInput.value = String(normalized.overlay);
  updateThemePreview(normalized);
}

function readThemeForm() {
  return normalizeTheme({
    ...currentTheme,
    mode: themeModeInput.value,
    solidColor: solidColorInput.value,
    gradientStart: gradientStartInput.value,
    gradientEnd: gradientEndInput.value,
    gradientAngle: gradientAngleInput.value,
    overlay: overlayInput.value
  });
}

function applyWorkspaceTheme(theme) {
  const normalized = normalizeTheme(theme);
  const overlay = Math.min(Math.max(Number(normalized.overlay) || 0, 0), 80) / 100;
  document.body.classList.add('custom-workspace-theme');
  document.body.style.setProperty('--workspace-theme-background', buildThemeBackground(normalized));
  document.body.style.setProperty('--workspace-theme-overlay', `rgba(8, 9, 10, ${overlay})`);
  updateThemePreview(normalized);
}

function updateThemePreview(theme) {
  if (!themePreview) {
    return;
  }
  const normalized = normalizeTheme(theme);
  const overlay = Math.min(Math.max(Number(normalized.overlay) || 0, 0), 80) / 100;
  themePreview.style.background = `linear-gradient(rgba(8, 9, 10, ${overlay}), rgba(8, 9, 10, ${overlay})), ${buildThemeBackground(
    normalized
  )}`;
}

function buildThemeBackground(theme) {
  if (theme.mode === 'solid') {
    return `linear-gradient(${theme.solidColor}, ${theme.solidColor})`;
  }

  if (theme.mode === 'image' && theme.imageUrl) {
    return `url("${getThemeImageUrl(theme.imageUrl)}") center / cover no-repeat`;
  }

  return `linear-gradient(${theme.gradientAngle}deg, ${theme.gradientStart}, ${theme.gradientEnd})`;
}

function getThemeImageUrl(imageUrl) {
  if (!imageUrl) {
    return '';
  }
  return imageUrl.startsWith('/api/') ? `${API_BASE_URL}${imageUrl}` : imageUrl;
}

function normalizeTheme(theme) {
  const fallback = getDefaultTheme();
  const source = theme && typeof theme === 'object' ? theme : {};
  const imageUrl = String(source.imageUrl || '').trim();
  const mode = ['solid', 'gradient', 'image'].includes(source.mode) ? source.mode : fallback.mode;

  return {
    mode: mode === 'image' && !imageUrl ? 'gradient' : mode,
    solidColor: normalizeHexColor(source.solidColor, fallback.solidColor),
    gradientStart: normalizeHexColor(source.gradientStart, fallback.gradientStart),
    gradientEnd: normalizeHexColor(source.gradientEnd, fallback.gradientEnd),
    gradientAngle: clampNumber(source.gradientAngle, 0, 360, fallback.gradientAngle),
    imageUrl,
    overlay: clampNumber(source.overlay, 0, 80, fallback.overlay)
  };
}

function getDefaultTheme() {
  return {
    mode: 'gradient',
    solidColor: '#08090a',
    gradientStart: '#08090a',
    gradientEnd: '#0f2f2b',
    gradientAngle: 135,
    imageUrl: '',
    overlay: 28
  };
}

function normalizeHexColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(number), min), max);
}

function readCachedTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value ? normalizeTheme(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

function cacheTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(normalizeTheme(theme)));
  } catch {
    // Local storage can be disabled by browser policy.
  }
}

async function loadKeyCount() {
  if (!keyCount) {
    return;
  }

  try {
    const payload = await api('/api/vault/credentials');
    keyCount.textContent = String((payload.credentials || []).length);
  } catch {
    keyCount.textContent = '0';
  }
}

function renderGroups(groups) {
  if (groups.length === 0) {
    content.className = 'workspace-empty';
    content.innerHTML = '<p>暂时没有匹配的站点。可以换个关键词试试，管理员也可以在后台补充新的入口。</p>';
    return;
  }

  content.className = 'system-sections';
  content.innerHTML = groups
    .map(
      (group) => `<section class="system-section">
  <div class="system-section-head">
    <div>
      <h3>${escapeHtml(group.name)}</h3>
      <p>${escapeHtml(group.description || '已经整理好的内部系统入口')}</p>
    </div>
    <span>${(group.sites || []).length} 个入口在线</span>
  </div>
  <div class="system-grid">${renderSites(group.sites || [])}</div>
</section>`
    )
    .join('');
}

function renderSites(sites) {
  if (sites.length === 0) {
    return '<p class="section-empty">这个分组还没有站点，等管理员放入新的入口。</p>';
  }

  return sites
    .map(
      (site) => `<a class="system-card" href="${escapeHtml(createSsoUrl(site))}" target="_blank" rel="noreferrer">
  <span class="system-icon" style="background: ${getSiteGradient(site.name)};">${getSiteIcon(site.name)}</span>
  <div class="system-card-body">
    <strong>${escapeHtml(site.name)}</strong>
    <p>${escapeHtml(site.description || '安全打开这个内部系统')}</p>
  </div>
  <div class="system-card-foot">
    <div class="system-tags">${(site.tags || []).map((tag) => `<b>${escapeHtml(tag)}</b>`).join('')}</div>
    <span class="system-open">进入</span>
  </div>
</a>`
    )
    .join('');
}

function filterGroups(groups, keyword) {
  const query = keyword.trim().toLowerCase();
  if (!query) {
    return groups;
  }

  return groups
    .map((group) => ({
      ...group,
      sites: (group.sites || []).filter((site) => {
        const text = `${site.name} ${site.description} ${(site.tags || []).join(' ')}`.toLowerCase();
        return text.includes(query);
      })
    }))
    .filter((group) => group.sites.length > 0);
}

function updateDirectorySummary(groups, keyword) {
  const total = countSites(groups);
  directorySummary.textContent = keyword.trim()
    ? `已为你筛出 ${total} 个入口`
    : `已连接 ${groups.length} 个应用分组，${total} 个站点入口`;
}

function countSites(groups) {
  return groups.reduce((total, group) => total + (group.sites || []).length, 0);
}

function getSiteIcon(name = '') {
  const icons = {
    '万弘': '📦',
    '虹硕': '🏢',
    'TeamKB': '📋',
    'TeamKb': '📋',
    '文件': '📤',
    'Claude': '🤖',
    'Things': '📡',
    'Quant': '🛒',
    'Gitea': '🔀',
    'n8n': '⚡',
    'Mirr': '🪟',
    'Watch': '👁',
    'CDN': '🌐',
    'AI API': '🔑',
  };
  for (const [key, icon] of Object.entries(icons)) {
    if (name.includes(key)) return icon;
  }
  return '🔗';
}

function getSiteGradient(name = '') {
  const gradients = {
    '万弘': 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    '虹硕': 'linear-gradient(135deg, #10b981, #059669)',
    'TeamKB': 'linear-gradient(135deg, #f97316, #ef4444)',
    'TeamKb': 'linear-gradient(135deg, #3b82f6, #2563eb)',
    '文件': 'linear-gradient(135deg, #06b6d4, #0891b2)',
    'Claude': 'linear-gradient(135deg, #a855f7, #d946ef)',
    'Things': 'linear-gradient(135deg, #22c55e, #16a34a)',
    'Quant': 'linear-gradient(135deg, #f59e0b, #d97706)',
    'Gitea': 'linear-gradient(135deg, #f97316, #ea580c)',
    'n8n': 'linear-gradient(135deg, #14b8a6, #0d9488)',
    'Mirr': 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
    'Watch': 'linear-gradient(135deg, #ec4899, #db2777)',
    'CDN': 'linear-gradient(135deg, #4f46e5, #4338ca)',
    'AI API': 'linear-gradient(135deg, #6b7280, #4b5563)',
  };
  for (const [key, gradient] of Object.entries(gradients)) {
    if (name.includes(key)) return gradient;
  }
  return 'linear-gradient(135deg, #6366f1, #8b5cf6)';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

