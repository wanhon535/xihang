import { API_BASE_URL } from '../config.js';
import { api } from '../api.js';

const LOGIN_SCRIPT_VERSION = '20260524-consent1';
const loginBtn = document.querySelector('#loginBtn');
const passwordLoginForm = document.querySelector('#passwordLoginForm');
const usernameInput = document.querySelector('#usernameInput');
const passwordInput = document.querySelector('#passwordInput');
const errorText = document.querySelector('#errorText');
const tabButtons = [...document.querySelectorAll('[data-login-tab]')];
const loginPanels = [...document.querySelectorAll('.login-panel')];
const passwordToggleBtn = document.querySelector('#passwordToggleBtn');
const dingtalkFrame = document.querySelector('#dingtalkFrame');
const dingtalkLoading = document.querySelector('#dingtalkLoading');
const dingtalkQrBox = document.querySelector('#dingtalkQrBox');
const dingtalkStatus = document.querySelector('#dingtalkStatus');
const dingtalkRefreshBtn = document.querySelector('#dingtalkRefreshBtn');
const debugPanel = document.querySelector('#dingtalkDebugPanel');
const debugVersion = document.querySelector('#debugVersion');
const debugScriptState = document.querySelector('#debugScriptState');
const debugFrameState = document.querySelector('#debugFrameState');
const debugMessageState = document.querySelector('#debugMessageState');
const debugEventList = document.querySelector('#debugEventList');
const params = new URLSearchParams(window.location.search);
const error = params.get('error');
const authHandoff = params.get('auth_handoff');
const initialTab = params.get('tab');
const shouldOpenDingTalkTab = initialTab === 'dingtalk' || Boolean(error && error.includes('钉钉'));
let dingtalkLoadedOnce = false;
let dingtalkRevealTimer = null;
let dingtalkExpireTimer = null;
let dingtalkMessageCount = 0;
let windowMessageCount = 0;
let frontendEventSeq = 0;
const debugEvents = [];

setDebugText(debugVersion, LOGIN_SCRIPT_VERSION);
setDebugText(debugScriptState, '已加载');

if (error) {
  errorText.textContent = error;
  errorText.classList.remove('hidden');
  clientLog('login.error-param', error, { queryKeys: [...params.keys()] });
}

if (authHandoff) {
  clientLog('handoff.detected');
  consumeAuthHandoff(authHandoff);
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  logWindowMessage(event);

  if (isDingTalkMessage(event)) {
    logDingTalkMessage(event);
    handleDingTalkProtocolMessage(event);
  }

  const nativeRedirect = getDingTalkNativeRedirect(data);
  if (nativeRedirect) {
    handleDingTalkNativeRedirect(nativeRedirect, event.origin);
    return;
  }

  if (data.type !== 'xihang:dingtalk-auth' || typeof data.target !== 'string') {
    return;
  }

  try {
    const target = new URL(data.target);
    if (target.origin === window.location.origin && target.pathname === '/login.html') {
      clientLog('postmessage.accepted', target.searchParams.has('auth_handoff') ? 'has_handoff' : 'no_handoff');
      if (dingtalkStatus) {
        dingtalkStatus.textContent = '扫码成功，正在进入汐航。';
      }
      window.location.href = target.toString();
    }
  } catch {
    // ignore malformed messages
  }
});

loginBtn.href = `${API_BASE_URL}/api/auth/dingtalk`;
clientLog('login-script.ready', LOGIN_SCRIPT_VERSION, {
  apiBaseUrl: API_BASE_URL,
  queryKeys: [...params.keys()],
  initialTab: initialTab || '',
  hasError: Boolean(error),
  hasAuthHandoff: Boolean(authHandoff),
  userAgent: navigator.userAgent
});

window.addEventListener('focus', () => clientLog('window.focus'));
window.addEventListener('blur', () => clientLog('window.blur'));
window.addEventListener('pagehide', () => clientLog('window.pagehide'));
window.addEventListener('beforeunload', () => clientLog('window.beforeunload'));
window.addEventListener('error', (event) => {
  clientLog('window.error', event.message || 'script error', {
    source: event.filename || '',
    line: event.lineno || 0,
    column: event.colno || 0
  });
});
window.addEventListener('unhandledrejection', (event) => {
  clientLog('window.unhandledrejection', event.reason?.message || String(event.reason || ''));
});
document.addEventListener('visibilitychange', () => {
  clientLog('document.visibilitychange', document.visibilityState);
});
dingtalkFrame?.addEventListener('load', () => {
  setDebugText(debugFrameState, 'iframe 已加载');
  clientLog('iframe.load', '', {
    src: summarizeUrl(dingtalkFrame.src),
    statusText: dingtalkStatus?.textContent || ''
  });
});
dingtalkFrame?.addEventListener('error', () => {
  setDebugText(debugFrameState, 'iframe 错误');
  clientLog('iframe.error', '', {
    src: summarizeUrl(dingtalkFrame.src),
    statusText: dingtalkStatus?.textContent || ''
  });
});

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    clientLog('tab.click', button.dataset.loginTab || '');
    switchLoginTab(button.dataset.loginTab);
  });
});

dingtalkRefreshBtn?.addEventListener('click', () => {
  clientLog('dingtalk.refresh.click');
  loadDingTalkLogin({ force: true });
});

dingtalkQrBox?.addEventListener('click', (event) => {
  clientLog('dingtalk.qrbox.click', '', {
    target: event.target?.id || event.target?.tagName || '',
    frameSrc: summarizeUrl(dingtalkFrame?.src || '')
  });
  if (event.target === dingtalkFrame) {
    return;
  }
  loadDingTalkLogin({ force: true });
});

loginBtn?.addEventListener('click', () => {
  clientLog('dingtalk.fullpage.click', '', {
    href: summarizeUrl(loginBtn.href || '')
  });
});

if (!authHandoff && shouldOpenDingTalkTab) {
  switchLoginTab('dingtalk', { preserveError: Boolean(error) });
}

passwordToggleBtn?.addEventListener('click', () => {
  const shouldShow = passwordInput.type === 'password';
  passwordInput.type = shouldShow ? 'text' : 'password';
  passwordToggleBtn.textContent = shouldShow ? '隐藏' : '显示';
  passwordToggleBtn.title = shouldShow ? '隐藏密码' : '显示密码';
});

passwordLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  clientLog('password-login.submit', '', { usernameLength: usernameInput.value.length });

  try {
    const payload = await api('/api/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({
        username: usernameInput.value,
        password: passwordInput.value
      })
    });
    window.location.href = payload.user?.mustChangePassword ? '/change-password.html' : '/';
  } catch (loginError) {
    showError(loginError.message);
  }
});

api('/api/auth/me')
  .then((payload) => {
    if (payload.user) {
      window.location.href = payload.user.mustChangePassword ? '/change-password.html' : '/';
    }
  })
  .catch(() => {});

function showError(message) {
  if (!message) {
    errorText.classList.add('hidden');
    errorText.textContent = '';
    return;
  }

  errorText.textContent = message;
  errorText.classList.remove('hidden');
}

function switchLoginTab(tab, options = {}) {
  clientLog('tab.switch', tab || '', { preserveError: Boolean(options.preserveError) });
  tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.loginTab === tab));
  loginPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `${tab}-panel`));
  if (!options.preserveError) {
    showError('');
  }
  if (tab === 'dingtalk') {
    loadDingTalkLogin({ force: true });
  }
}

async function loadDingTalkLogin({ force = false } = {}) {
  clientLog('auth-url.load.start', force ? 'force' : 'normal', {
    loadedOnce: dingtalkLoadedOnce,
    frameSrc: summarizeUrl(dingtalkFrame?.src || '')
  });
  if (!loginBtn || !dingtalkFrame) {
    clientLog('auth-url.load.skipped', 'missing elements', {
      hasLoginBtn: Boolean(loginBtn),
      hasFrame: Boolean(dingtalkFrame)
    });
    return;
  }

  if (dingtalkLoadedOnce && !force) {
    clientLog('auth-url.load.skipped', 'already loaded');
    return;
  }

  dingtalkLoadedOnce = true;
  window.clearTimeout(dingtalkRevealTimer);
  window.clearTimeout(dingtalkExpireTimer);
  dingtalkLoading?.classList.remove('hidden');
  dingtalkFrame.removeAttribute('src');
  setDebugText(debugFrameState, '请求授权链接');

  if (dingtalkStatus) {
    dingtalkStatus.textContent = '正在加载钉钉官方扫码';
  }

  try {
    const payload = await api('/api/auth/dingtalk/url');
    loginBtn.href = payload.fullPageAuthUrl || `${API_BASE_URL}/api/auth/dingtalk`;
    const scope = payload.authUrl ? new URL(payload.authUrl).searchParams.get('scope') || '' : '';
    clientLog('auth-url.loaded', scope, {
      configured: Boolean(payload.configured),
      authUrl: summarizeUrl(payload.authUrl || ''),
      fullPageAuthUrl: summarizeUrl(payload.fullPageAuthUrl || ''),
      loginUrl: summarizeUrl(payload.loginUrl || '')
    });

    if (!payload.configured) {
      if (dingtalkStatus) {
        dingtalkStatus.textContent = payload.message || '钉钉配置未完成';
      }
      clientLog('auth-url.unconfigured', payload.message || '');
      return;
    }

    const revealFrame = () => {
      window.clearTimeout(dingtalkRevealTimer);
      window.setTimeout(() => dingtalkLoading?.classList.add('hidden'), 800);
      if (dingtalkStatus) {
        dingtalkStatus.textContent = '二维码已加载，请使用钉钉扫码确认。';
      }
      clientLog('iframe.reveal', '', { frameSrc: summarizeUrl(dingtalkFrame.src) });
    };

    dingtalkFrame.onload = revealFrame;
    dingtalkFrame.src = payload.authUrl;
    setDebugText(debugFrameState, '已设置二维码地址');
    clientLog('iframe.src.set', '', { authUrl: summarizeUrl(payload.authUrl || '') });

    if (dingtalkStatus) {
      dingtalkStatus.textContent = '请使用钉钉扫码确认登录。';
    }

    dingtalkRevealTimer = window.setTimeout(() => {
      if (dingtalkStatus) {
        dingtalkStatus.textContent = '如果二维码没有出现，请点刷新二维码。';
      }
      clientLog('iframe.reveal.timeout', '', { frameSrc: summarizeUrl(dingtalkFrame.src) });
    }, 6000);

    dingtalkExpireTimer = window.setTimeout(() => {
      if (dingtalkStatus) {
        dingtalkStatus.textContent = '二维码可能已过期，点击二维码区域刷新。';
      }
      clientLog('iframe.expire.hint', '', { frameSrc: summarizeUrl(dingtalkFrame.src) });
    }, 1000 * 90);
  } catch (loadError) {
    if (dingtalkStatus) {
      dingtalkStatus.textContent = loadError.message || '钉钉授权链接加载失败';
    }
    clientLog('auth-url.failed', loadError.message || '', { stack: loadError.stack || '' });
  }
}

function logWindowMessage(event) {
  windowMessageCount += 1;
  setDebugText(debugMessageState, `收到消息 ${windowMessageCount}`);
  if (windowMessageCount > 40) {
    return;
  }
  clientLog('postmessage.any', '', {
    index: windowMessageCount,
    origin: event.origin || '',
    sourceIsDingTalkFrame: Boolean(dingtalkFrame?.contentWindow && event.source === dingtalkFrame.contentWindow),
    data: summarizeMessageData(event.data)
  });
}

function isDingTalkMessage(event) {
  const origin = String(event.origin || '').toLowerCase();
  if (origin.includes('dingtalk.com')) {
    return true;
  }

  const data = event.data || {};
  return Boolean(getDingTalkNativeRedirect(data) || data.code || data.authCode || data.redirectUrl);
}

function logDingTalkMessage(event) {
  dingtalkMessageCount += 1;
  setDebugText(debugMessageState, `钉钉消息 ${dingtalkMessageCount}`);
  if (dingtalkMessageCount > 8) {
    return;
  }

  const data = event.data || {};
  const keys = typeof data === 'object' ? Object.keys(data).slice(0, 12).join(',') : typeof data;
  const nestedKeys =
    typeof data?.data === 'object' && data.data ? ` data:${Object.keys(data.data).slice(0, 8).join(',')}` : '';
  clientLog('postmessage.dingtalk', `${event.origin || 'unknown'} keys:${keys}${nestedKeys}`, {
    sourceIsDingTalkFrame: Boolean(dingtalkFrame?.contentWindow && event.source === dingtalkFrame.contentWindow),
    data: summarizeMessageData(data)
  });
}

function handleDingTalkProtocolMessage(event) {
  const data = event.data || {};
  if (typeof data !== 'object') {
    return;
  }

  if (data.type === 'get-iframe-pos') {
    replyDingTalkFramePosition(event);
    if (dingtalkStatus) {
      dingtalkStatus.textContent = '已检测到钉钉扫码交互，等待授权返回。';
    }
    setDebugText(debugMessageState, '已回复位置');
    return;
  }

  if (data.type === 'iframe-click') {
    if (dingtalkStatus) {
      dingtalkStatus.textContent = '已检测到钉钉确认动作，等待登录结果。';
    }
    setDebugText(debugMessageState, '扫码交互中');
    clientLog('dingtalk.protocol.iframe-click', '', {
      sourceIsDingTalkFrame: Boolean(dingtalkFrame?.contentWindow && event.source === dingtalkFrame.contentWindow)
    });
    return;
  }

  if (data.success === false || data.errorMsg) {
    const message = data.errorMsg || '钉钉扫码失败，请刷新二维码后重试。';
    clientLog('dingtalk.protocol.error', message);
    showError(message);
  }
}

function replyDingTalkFramePosition(event) {
  if (!event.source || !dingtalkFrame) {
    return;
  }

  const rect = dingtalkFrame.getBoundingClientRect();
  const position = {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  };
  const reply = {
    type: 'iframe-pos',
    event: 'iframe-pos',
    data: position,
    ...position
  };

  try {
    event.source.postMessage(reply, event.origin || '*');
    clientLog('dingtalk.protocol.iframe-pos.reply', '', {
      origin: event.origin || '',
      position
    });
  } catch (error) {
    clientLog('dingtalk.protocol.iframe-pos.failed', error.message || '');
  }
}

function getDingTalkNativeRedirect(data = {}) {
  if (typeof data.redirectUrl === 'string') {
    return data.redirectUrl;
  }
  if (typeof data.data?.redirectUrl === 'string') {
    return data.data.redirectUrl;
  }
  if (typeof data.params?.redirectUrl === 'string') {
    return data.params.redirectUrl;
  }
  if (typeof data.url === 'string' && (data.url.includes('/api/auth/dingtalk/callback') || data.url.includes('code='))) {
    return data.url;
  }

  const authCode = data.code || data.authCode || data.data?.code || data.data?.authCode;
  const state = data.state || data.data?.state || '';
  if (!authCode) {
    return '';
  }

  const target = new URL(`${API_BASE_URL}/api/auth/dingtalk/callback`);
  target.searchParams.set('code', String(authCode));
  target.searchParams.set('authCode', String(authCode));
  if (state) {
    target.searchParams.set('state', String(state));
  }
  return target.toString();
}

function handleDingTalkNativeRedirect(redirectUrl, sourceOrigin) {
  try {
    const target = new URL(redirectUrl, window.location.href);
    const hasAuthCode = target.searchParams.has('code') || target.searchParams.has('authCode');
    const isCallback = target.pathname === '/api/auth/dingtalk/callback';
    clientLog(
      'native-postmessage.received',
      `${sourceOrigin || 'unknown'} ${hasAuthCode ? 'has_code' : 'no_code'} ${isCallback ? 'callback' : 'other'}`,
      { target: summarizeUrl(target.toString()) }
    );

    if (!hasAuthCode || !isCallback) {
      showError('钉钉扫码返回内容无效，请刷新二维码后重试。');
      return;
    }

    if (dingtalkStatus) {
      dingtalkStatus.textContent = '扫码成功，正在完成登录。';
    }
    setDebugText(debugMessageState, '扫码成功');
    window.location.href = target.toString();
  } catch (err) {
    clientLog('native-postmessage.failed', err.message || '');
    showError('钉钉扫码返回内容无效，请刷新二维码后重试。');
  }
}

async function consumeAuthHandoff(token) {
  showError('');
  try {
    clientLog('handoff.posting');
    const payload = await api('/api/auth/handoff-login', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
    clientLog('handoff.success', payload.user?.mustChangePassword ? 'change-password' : 'home');
    window.history.replaceState(null, '', '/login.html');
    window.location.href = payload.user?.mustChangePassword ? '/change-password.html' : '/';
  } catch (handoffError) {
    clientLog('handoff.failed', handoffError.message || '');
    showError(handoffError.message);
    window.history.replaceState(null, '', '/login.html');
  }
}

function summarizeMessageData(data) {
  if (data === null || data === undefined) {
    return { kind: String(data) };
  }
  if (typeof data !== 'object') {
    return {
      kind: typeof data,
      text: String(data).slice(0, 180)
    };
  }

  const nested = typeof data.data === 'object' && data.data ? data.data : {};
  return {
    kind: Array.isArray(data) ? 'array' : 'object',
    keys: Object.keys(data).slice(0, 20),
    nestedKeys: Object.keys(nested).slice(0, 12),
    type: String(data.type || data.event || data.action || '').slice(0, 80),
    success: data.success === undefined ? undefined : Boolean(data.success),
    hasRedirectUrl: Boolean(data.redirectUrl || data.data?.redirectUrl || data.params?.redirectUrl || data.url),
    hasCode: Boolean(data.code || data.authCode || data.data?.code || data.data?.authCode),
    redirectUrl: summarizeUrl(data.redirectUrl || data.data?.redirectUrl || data.params?.redirectUrl || data.url || '')
  };
}

function summarizeUrl(value) {
  if (!value) {
    return {};
  }
  try {
    const url = new URL(value, window.location.href);
    return {
      origin: url.origin,
      pathname: url.pathname,
      scope: url.searchParams.get('scope') || '',
      prompt: url.searchParams.get('prompt') || '',
      iframe: url.searchParams.get('iframe') || '',
      orgType: url.searchParams.get('org_type') || '',
      iframeTips: url.searchParams.get('FEShowIframeTips') || '',
      hasCorpId: url.searchParams.has('corpId'),
      hasCode: url.searchParams.has('code') || url.searchParams.has('authCode'),
      hasState: url.searchParams.has('state'),
      stateLength: (url.searchParams.get('state') || '').length,
      redirectOrigin: getUrlOrigin(url.searchParams.get('redirect_uri') || '')
    };
  } catch {
    return { invalid: true, text: String(value).slice(0, 160) };
  }
}

function getUrlOrigin(value) {
  if (!value) {
    return '';
  }
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function getActiveLoginTab() {
  return tabButtons.find((button) => button.classList.contains('active'))?.dataset.loginTab || '';
}

function clientLog(event, detail = '', meta = {}) {
  frontendEventSeq += 1;
  updateDebugPanel(event, detail, meta);
  const payload = JSON.stringify({
    event,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
    href: window.location.href,
    path: window.location.pathname,
    meta: {
      seq: frontendEventSeq,
      version: LOGIN_SCRIPT_VERSION,
      activeTab: getActiveLoginTab(),
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      ...meta
    }
  });

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${API_BASE_URL}/api/auth/dingtalk/client-log`, new Blob([payload], { type: 'application/json' }));
      return;
    }
  } catch {}

  fetch(`${API_BASE_URL}/api/auth/dingtalk/client-log`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive: true
  }).catch(() => {});
}

function setDebugText(element, text) {
  if (element) {
    element.textContent = text;
  }
}

function updateDebugPanel(event, detail, meta) {
  if (!debugPanel || !debugEventList) {
    return;
  }

  const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  const summary = summarizeDebugEvent(event, detailText, meta);
  debugEvents.unshift({
    seq: frontendEventSeq,
    event,
    summary,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  });
  debugEvents.splice(8);
  debugEventList.innerHTML = debugEvents
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.time)}</span><strong>${escapeHtml(item.event)}</strong><em>${escapeHtml(item.summary)}</em></li>`
    )
    .join('');
}

function summarizeDebugEvent(event, detail, meta = {}) {
  if (event === 'auth-url.loaded') {
    return `${detail || ''} ${meta?.authUrl?.prompt || 'no-prompt'} ${meta?.authUrl?.hasCorpId ? 'corpId' : 'no-corpId'}`.trim();
  }
  if (event === 'iframe.src.set' || event === 'iframe.load' || event === 'iframe.reveal') {
    const source = meta?.authUrl || meta?.src || meta?.frameSrc || {};
    return `${source.scope || ''} ${source.prompt || ''}`.trim();
  }
  if (event.includes('postmessage')) {
    return meta?.data?.keys?.join(',') || detail || '';
  }
  return String(detail || '').slice(0, 64);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

