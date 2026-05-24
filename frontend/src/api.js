import { API_BASE_URL } from './config.js';

export async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || '请求失败');
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }

  return payload;
}

export function redirectToLogin(error) {
  const query = error ? `?error=${encodeURIComponent(error)}` : '';
  window.location.href = `/login.html${query}`;
}

export async function requireUser() {
  const payload = await api('/api/auth/me');
  if (!payload.user) {
    redirectToLogin();
    return null;
  }

  if (payload.user.mustChangePassword && window.location.pathname !== '/change-password.html') {
    window.location.href = '/change-password.html';
    return null;
  }

  return payload.user;
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  redirectToLogin();
}

export function createSsoUrl(site) {
  const urlStr = window.location.origin + '/api/sso/authorize';
  const url = new URL(urlStr);
  if (site && typeof site === 'object') {
    if (site.id) {
      url.searchParams.set('siteId', site.id);
    } else {
      url.searchParams.set('redirect', site.url || '');
    }
    return url.toString();
  }

  url.searchParams.set('redirect', site);
  return url.toString();
}
