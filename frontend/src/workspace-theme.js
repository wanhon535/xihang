import { API_BASE_URL } from './config.js';

const validColor = (value, fallback) => /^#[\da-f]{6}$/i.test(value || '') ? value : fallback;
const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
const blend = (a, b, ratio) => '#' + a.map((value, i) => Math.round(value * (1 - ratio) + b[i] * ratio).toString(16).padStart(2, '0')).join('');

export function applyPersonalTheme(theme = {}) {
  const solid = validColor(theme.solidColor, '#0d1119');
  const start = validColor(theme.gradientStart, '#081625');
  const end = validColor(theme.gradientEnd, '#123f54');
  const base = rgb(theme.mode !== 'gradient' ? solid : blend(rgb(start), rgb(end), .5));
  // Derive related dark surfaces even when the selected background is very light.
  const strongest = Math.max(...base, 1);
  const tint = base.map(value => Math.round(value * Math.min(1, 160 / strongest)));
  const surface = ratio => blend([13, 17, 25], tint, ratio);
  let primary = tint.map(value => Math.round(value / Math.max(...tint, 1) * 220));
  const luminance = values => values.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  if (Math.max(...primary) < 20) primary = [59, 130, 246];
  while (luminance(primary) > .18) primary = primary.map(value => Math.floor(value * .95));
  const primaryHex = blend(primary, primary, 0);
  const tokens = {
    '--primary': primaryHex, '--accent': primaryHex, '--primary-hover': blend(primary, [0,0,0], .15),
    '--canvas': surface(.12), '--surface': surface(.3), '--surface-2': surface(.4), '--surface-3': surface(.45),
    '--rail-surface': surface(.4), '--line': surface(.43), '--line-strong': surface(.62),
    '--theme-soft': surface(.48), '--theme-hover': surface(.38),
    '--theme-accent': blend(tint, [200, 226, 255], .72)
  };
  for (const [name, value] of Object.entries(tokens)) document.body.style.setProperty(name, value);
  const overlay = Math.min(80, Math.max(0, Number(theme.overlay) || 0)) / 100;
  const angle = Math.min(360, Math.max(0, (Number.isFinite(Number(theme.gradientAngle)) ? Number(theme.gradientAngle) : 135)));
  let background = theme.mode === 'solid' ? `linear-gradient(${solid}, ${solid})` : `linear-gradient(${angle}deg, ${start}, ${end})`;
  const image = String(theme.imageUrl || '');
  if (theme.mode === 'image' && (/^(?:\/api\/user\/workspace-theme\/backgrounds|\/uploads\/workspace-backgrounds\/\d+)\/[\w.-]+$/.test(image))) {
    background = `url("${API_BASE_URL}${image}") center / cover no-repeat`;
  }
  const overlayColor = `rgba(8,9,10,${overlay})`;
  document.body.style.setProperty('--workspace-theme-background', background);
  document.body.style.setProperty('--workspace-theme-overlay', overlayColor);
  document.body.classList.add('custom-workspace-theme');
  document.body.classList.toggle('image-workspace-theme', theme.mode === 'image' && !!image);
  cacheThemeSnapshot({ tokens, background, overlayColor, isImage: theme.mode === 'image' && !!image });
}

// The next page load is a full MPA navigation with no way to know the theme
// before its own network round trip resolves, so it would otherwise paint the
// default dark canvas first and visibly flash to the real theme. Caching the
// last-applied theme lets a tiny inline bootstrap script (see index.html etc.)
// paint the right colors before first paint; this function then reconciles it
// with the authoritative fetch as usual.
function cacheThemeSnapshot(snapshot) {
  try { localStorage.setItem('tidesail.theme.snapshot', JSON.stringify(snapshot)); } catch {}
}

