import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');

test('shared toast exposes a body-level, trigger-aware feedback contract', () => {
  const file = 'frontend/src/ui-feedback.js';
  assert.ok(existsSync(file), 'shared feedback module should exist');
  const source = read(file);
  assert.match(source, /export function showToast\(message, trigger\)/);
  assert.match(source, /appToastRegion/);
  assert.match(source, /getBoundingClientRect/);
  assert.match(source, /aria-live/);
});

test('seasonal particles are initialized from the shared shell on every workspace page', () => {
  const particles = read('frontend/src/seasonal-particles.js');
  const shell = read('frontend/src/shell.js');
  const main = read('frontend/src/pages/main.js');
  assert.doesNotMatch(particles, /!document\.body\.classList\.contains\('home-page'\)/);
  assert.match(shell, /mountSeasonalParticles/);
  assert.doesNotMatch(main, /initSeasonalParticles/);
});

test('the shell mounts the ambient layer before page authentication is hydrated', () => {
  const shell = read('frontend/src/shell.js');
  const particles = read('frontend/src/seasonal-particles.js');
  assert.match(shell, /import \{ mountSeasonalParticles, setSeasonalParticleUser \} from ['"]\.\/seasonal-particles\.js['"]/);
  assert.match(shell, /initAppearance\(\);\s*mountSeasonalParticles\(\);/s);
  assert.match(shell, /setSeasonalParticleUser\(user\)/);
  assert.match(particles, /export function mountSeasonalParticles\(\)/);
  assert.match(particles, /export function setSeasonalParticleUser\(user\)/);
});

test('ambient and feedback layers have explicit non-blocking stacking rules', () => {
  const css = read('frontend/src/styles/admin-layout.css');
  assert.match(css, /\.vben-shell\.console-page #appAmbientLayer\s*\{[^}]*position:fixed/);
  assert.match(css, /\.vben-shell\.console-page #appAmbientLayer\s*\{[^}]*pointer-events:none/);
  assert.match(css, /#appToastRegion\s*\{[^}]*position:fixed/);
  assert.match(css, /#appToastRegion\s*\{[^}]*pointer-events:none/);
  assert.match(css, /#appToastRegion\s*\{[^}]*z-index:\s*\d+/);
});

test('all authenticated workspace entrypoints continue through the shared user shell', () => {
  for (const file of ['main.js', 'vault.js', 'admin.js', 'ledger.js']) {
    assert.match(read(`frontend/src/pages/${file}`), /import \{[^}]*\bsetWorkspaceUser\b[^}]*\} from ['"]\.\.\/shell\.js['"]/);
  }
});

test('workspace shell keeps the workspace navigation and hides repeated page headings', () => {
  const shell = read('frontend/src/shell.js');
  const css = read('frontend/src/styles/admin-layout.css');
  assert.match(shell, /className = 'workspace-tabs'/);
  assert.match(shell, /body\.prepend\(header, tabs\)/);
  assert.match(shell, /const tabs = document\.querySelector\('\.workspace-tabs'\)/);
  assert.doesNotMatch(shell, /new MutationObserver/);
  assert.match(css, /\.vben-shell\.console-page \.workspace-tabs\s*\{/);
  assert.match(css, /\.vben-shell\.console-page \.console-main \{[^}]*padding:116px 24px 24px/);
  // The shared shell header + tab strip already name the current page, so the
  // per-page h1 in .console-topbar is hidden everywhere, not just on home.
  assert.match(css, /\.vben-shell\.console-page \.console-topbar\.page-heading\s*\{[^}]*display:none/);
});

test('seasonal particles sit above backgrounds but below content and controls', () => {
  const css = read('frontend/src/styles/admin-layout.css');
  assert.match(css, /\.vben-shell\.console-page #appAmbientLayer\s*\{[^}]*z-index:-1/);
  assert.match(css, /\.vben-shell\.console-page #seasonalParticles\s*\{[^}]*pointer-events:none/);
  assert.match(css, /\.vben-shell\.console-page \.console-main\s*\{[^}]*z-index:auto/);
  assert.match(css, /\.vben-shell\.console-page \.console-main > \*[^{]*\{[^}]*position:relative[^}]*z-index:3/);
});
