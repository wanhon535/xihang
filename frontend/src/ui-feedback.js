const TOAST_DURATION = 3500;
const VIEWPORT_MARGIN = 16;
let activeToast = null;
let dismissTimer = 0;
let removeTimer = 0;

export function showToast(message, trigger) {
  const text = String(message || '').trim();
  if (!text || !document.body) {
    return null;
  }

  const region = getToastRegion();
  clearTimeout(dismissTimer);
  clearTimeout(removeTimer);
  activeToast?.remove();

  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.dataset.state = 'entering';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.textContent = text;
  region.appendChild(toast);
  activeToast = toast;

  const place = () => placeToast(toast, trigger);
  requestAnimationFrame(() => {
    if (!toast.isConnected) {
      return;
    }
    place();
    toast.dataset.state = 'visible';
  });

  dismissTimer = window.setTimeout(() => {
    if (!toast.isConnected) {
      return;
    }
    toast.dataset.state = 'leaving';
    removeTimer = window.setTimeout(() => {
      toast.remove();
      if (activeToast === toast) {
        activeToast = null;
      }
    }, 180);
  }, TOAST_DURATION);

  return toast;
}

function getToastRegion() {
  let region = document.querySelector('#appToastRegion');
  if (region) {
    return region;
  }

  region = document.createElement('div');
  region.id = 'appToastRegion';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  document.body.appendChild(region);
  return region;
}

function placeToast(toast, trigger) {
  const triggerRect = getVisibleRect(trigger);
  const toastRect = toast.getBoundingClientRect();
  toast.classList.toggle('is-centered', !triggerRect);

  if (!triggerRect) {
    toast.style.left = '50%';
    toast.style.top = `${VIEWPORT_MARGIN}px`;
    toast.style.transform = 'translateX(-50%)';
    return;
  }

  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - toastRect.width - VIEWPORT_MARGIN);
  let left = triggerRect.left + triggerRect.width / 2 - toastRect.width / 2;
  let top = triggerRect.bottom + 12;
  if (top + toastRect.height > window.innerHeight - VIEWPORT_MARGIN) {
    top = triggerRect.top - toastRect.height - 12;
  }
  if (top < VIEWPORT_MARGIN) {
    top = VIEWPORT_MARGIN;
  }

  left = Math.min(Math.max(left, VIEWPORT_MARGIN), maxLeft);
  toast.style.left = `${Math.round(left)}px`;
  toast.style.top = `${Math.round(top)}px`;
  toast.style.transform = 'none';
}

function getVisibleRect(trigger) {
  if (!trigger || typeof trigger.getBoundingClientRect !== 'function') {
    return null;
  }

  const rect = trigger.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) {
    return null;
  }
  return rect;
}
