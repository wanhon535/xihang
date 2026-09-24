import { api } from './api.js';
import { API_BASE_URL } from './config.js';
import { applyPersonalTheme } from './workspace-theme.js';
import panelMarkup from './appearance-panel.html?raw';
let activeUserId;
let channel;
// Returns { load(user) } rather than relying on a module-scope variable that a
// separate loadAppearance() export would read: under Vite dev HMR, two import
// sites (shell.js and a page's own script) can end up resolving to two distinct
// module instances, silently desyncing that shared state so the theme never
// applies. Handing the loader back through the same call that set it up avoids
// the cross-instance dependency entirely.
export function initAppearance() {
  document.querySelector('.console-topbar').insertAdjacentHTML('afterend', panelMarkup);
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
let currentTheme = getDefaultTheme();

const THEME_PRESETS = {
  deep: {
    mode: 'gradient',
    solidColor: '#081625',
    gradientStart: '#081625',
    gradientEnd: '#123f54',
    gradientAngle: 135,
    overlay: 18
  },
  aurora: {
    mode: 'gradient',
    solidColor: '#0b1d31',
    gradientStart: '#0c2340',
    gradientEnd: '#1b6270',
    gradientAngle: 128,
    overlay: 18
  },
  graphite: {
    mode: 'gradient',
    solidColor: '#111a27',
    gradientStart: '#111a27',
    gradientEnd: '#254156',
    gradientAngle: 145,
    overlay: 18
  }
};

let themeDrawerBackdrop;
function ensureThemeDrawerBackdrop() {
  if (themeDrawerBackdrop) return themeDrawerBackdrop;
  themeDrawerBackdrop = document.createElement('button');
  themeDrawerBackdrop.type = 'button';
  themeDrawerBackdrop.className = 'theme-drawer-backdrop';
  themeDrawerBackdrop.setAttribute('aria-label', '关闭外观设置');
  themeDrawerBackdrop.hidden = true;
  themeDrawerBackdrop.addEventListener('click', closeThemePanel);
  document.body.append(themeDrawerBackdrop);
  return themeDrawerBackdrop;
}
function openThemePanel() {
  workspaceThemePanel?.classList.add('open');
  ensureThemeDrawerBackdrop().hidden = false;
  themeToggleBtn?.setAttribute('aria-expanded', 'true');
}
function closeThemePanel() {
  workspaceThemePanel?.classList.remove('open');
  if (themeDrawerBackdrop) themeDrawerBackdrop.hidden = true;
  themeToggleBtn?.setAttribute('aria-expanded', 'false');
}
themeToggleBtn?.setAttribute('aria-expanded', 'false');
themeToggleBtn?.addEventListener('click', () => {
  workspaceThemePanel?.classList.contains('open') ? closeThemePanel() : openThemePanel();
});
themePanelCloseBtn?.addEventListener('click', closeThemePanel);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && workspaceThemePanel?.classList.contains('open')) closeThemePanel();
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

function openFromHash() { if (location.hash === '#appearance') openThemePanel(); }
window.addEventListener('hashchange', openFromHash);
openFromHash();
async function loadWorkspaceTheme() {
  setThemeForm(currentTheme);

  try {
    const payload = await api('/api/user/workspace-theme');
    currentTheme = normalizeTheme(payload.theme);
    setThemeForm(currentTheme);
    applyWorkspaceTheme(currentTheme);
  } catch (error) {
    themeStatus.textContent = error.message || '外观读取失败，请刷新重试。';
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
    themeStatus.textContent = '外观已保存，所有内部页面同步生效。';
    channel?.postMessage({userId: activeUserId});
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
  setThemeForm(currentTheme);
  applyWorkspaceTheme(currentTheme);
  themeStatus.textContent = '正在预览，保存后同步到其他页面。';
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
  solidColorInput.closest('label').hidden = normalized.mode === 'gradient';
  solidColorInput.closest('label').querySelector('span').textContent = normalized.mode === 'image' ? '界面配色' : '纯色背景';
  [gradientStartInput, gradientEndInput, gradientAngleInput].forEach(input => input.closest('label').hidden = normalized.mode !== 'gradient');
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
  applyPersonalTheme(normalized);
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
    solidColor: '#081625',
    gradientStart: '#081625',
    gradientEnd: '#123f54',
    gradientAngle: 135,
    imageUrl: '',
    overlay: 18
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


  try {
    channel = new BroadcastChannel('tidesail-appearance');
    channel.onmessage = event => { if (event.data?.userId === activeUserId) void loadWorkspaceTheme(); };
  } catch {}
  return {
    load(user) {
      activeUserId = String(user.id);
      return loadWorkspaceTheme();
    }
  };
}
