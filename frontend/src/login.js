import { API_BASE_URL } from './config.js';
import { api } from './api.js';

const loginBtn = document.querySelector('#loginBtn');
const passwordLoginForm = document.querySelector('#passwordLoginForm');
const usernameInput = document.querySelector('#usernameInput');
const passwordInput = document.querySelector('#passwordInput');
const errorText = document.querySelector('#errorText');
const tabButtons = [...document.querySelectorAll('[data-login-tab]')];
const loginPanels = [...document.querySelectorAll('.login-panel')];
const passwordToggleBtn = document.querySelector('#passwordToggleBtn');
const params = new URLSearchParams(window.location.search);
const error = params.get('error');

if (error) {
  errorText.textContent = error;
  errorText.classList.remove('hidden');
}

loginBtn.href = `${API_BASE_URL}/api/auth/dingtalk`;

tabButtons.forEach((button) => {
  button.addEventListener('click', () => switchLoginTab(button.dataset.loginTab));
});

passwordToggleBtn?.addEventListener('click', () => {
  const shouldShow = passwordInput.type === 'password';
  passwordInput.type = shouldShow ? 'text' : 'password';
  passwordToggleBtn.textContent = shouldShow ? '隐藏' : '显示';
  passwordToggleBtn.title = shouldShow ? '隐藏密码' : '显示密码';
});

passwordLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

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

function switchLoginTab(tab) {
  tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.loginTab === tab));
  loginPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `${tab}-panel`));
  showError('');
}
