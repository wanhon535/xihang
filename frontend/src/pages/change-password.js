import { api, redirectToLogin } from '../api.js';

const form = document.querySelector('#changePasswordForm');
const currentPasswordInput = document.querySelector('#currentPasswordInput');
const nextPasswordInput = document.querySelector('#nextPasswordInput');
const confirmPasswordInput = document.querySelector('#confirmPasswordInput');
const errorText = document.querySelector('#errorText');
const strengthBar = document.querySelector('#password-strength-bar');
const strengthText = document.querySelector('#password-strength-text');

init();
nextPasswordInput.addEventListener('input', updateStrength);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const currentPassword = currentPasswordInput.value;
  const nextPassword = nextPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (nextPassword !== confirmPassword) {
    showError('两次输入的新密码不一致。');
    return;
  }

  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, nextPassword })
    });
    window.location.href = '/';
  } catch (error) {
    showError(error.message);
  }
});

async function init() {
  try {
    const payload = await api('/api/auth/me');
    if (!payload.user) {
      redirectToLogin();
      return;
    }
    if (!payload.user.mustChangePassword) {
      window.location.href = '/';
    }
  } catch {
    redirectToLogin();
  }
}

function showError(message) {
  if (!message) {
    errorText.classList.add('hidden');
    errorText.textContent = '';
    return;
  }

  errorText.textContent = message;
  errorText.classList.remove('hidden');
}

function updateStrength() {
  if (!strengthBar || !strengthText) {
    return;
  }

  const value = nextPasswordInput.value;
  const score = scorePassword(value);
  const labels = ['未填写', '弱', '中', '强'];
  strengthBar.dataset.score = String(score);
  strengthText.textContent = labels[score];
}

function scorePassword(value) {
  if (!value) {
    return 0;
  }
  const types = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  if (value.length >= 12 && types >= 3) {
    return 3;
  }
  if (value.length >= 8 && types >= 2) {
    return 2;
  }
  return 1;
}

