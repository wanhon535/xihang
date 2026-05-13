import { API_BASE_URL } from './config.js';
import { api } from './api.js';

const loginBtn = document.querySelector('#loginBtn');
const passwordLoginForm = document.querySelector('#passwordLoginForm');
const usernameInput = document.querySelector('#usernameInput');
const passwordInput = document.querySelector('#passwordInput');
const errorText = document.querySelector('#errorText');
const params = new URLSearchParams(window.location.search);
const error = params.get('error');

if (error) {
  errorText.textContent = error;
  errorText.classList.remove('hidden');
}

loginBtn.href = `${API_BASE_URL}/api/auth/dingtalk`;

passwordLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  try {
    await api('/api/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({
        username: usernameInput.value,
        password: passwordInput.value
      })
    });
    window.location.href = '/';
  } catch (loginError) {
    showError(loginError.message);
  }
});

api('/api/auth/me')
  .then((payload) => {
    if (payload.user) {
      window.location.href = '/';
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
