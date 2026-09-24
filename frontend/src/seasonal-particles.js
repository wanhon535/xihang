const MODES = ['auto', 'spring', 'summer', 'autumn', 'winter', 'off'];
const LABELS = { spring: '春 · 花瓣柳絮', summer: '夏 · 萤火流光', autumn: '秋 · 落叶', winter: '冬 · 飘雪' };
export function seasonForDate(date = new Date()) {
  return ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][date.getMonth()];
}

export function initSeasonalParticles(user) {
  if (!document.body.classList.contains('home-page') || document.querySelector('#seasonalParticles')) return;
  const preferenceKey = `tidesail.particles.${user.id}`;
  const sceneKey = `${preferenceKey}.scene`;
  const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch {} };
  let mode = read(localStorage, preferenceKey);
  if (!MODES.includes(mode)) mode = 'auto';
  const canvas = document.createElement('canvas');
  canvas.id = 'seasonalParticles'; canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) { canvas.remove(); return; }

  const field = document.createElement('label'); field.className = 'field seasonal-setting';
  field.innerHTML = '<span>首页季节氛围</span><select class="field-input" id="seasonalMode" aria-describedby="seasonalHint"><option value="auto">跟随季节（自动）</option><option value="spring">春 · 花瓣柳絮</option><option value="summer">夏 · 萤火流光</option><option value="autumn">秋 · 落叶</option><option value="winter">冬 · 飘雪</option><option value="off">关闭粒子效果</option></select><small id="seasonalHint" class="muted"></small>';
  document.querySelector('.theme-controls-grid').append(field);
  const select = field.querySelector('select'); select.value = mode;
  const hint = field.querySelector('small');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const constrained = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 2;
  const interval = 1000 / (constrained ? 20 : 24);
  let width = 0, height = 0, dpr = 1, particles = [], frame = 0, last = 0, nextSeasonCheck = 0;
  let season = mode === 'auto' || mode === 'off' ? seasonForDate() : mode;
  let started = true;
  let elapsed = 0;
  function makeParticle() {
    return { x: Math.random(), y: Math.random(), size: 1.5 + Math.random() * 3.5, speed: 8 + Math.random() * 15, phase: Math.random() * Math.PI * 2, spin: (Math.random() - .5) * .8, rotation: Math.random() * Math.PI * 2, sway: 3 + Math.random() * 8 };
  }
  const storedScene = read(sessionStorage, sceneKey);
  if (storedScene?.season === season && Array.isArray(storedScene.particles)) {
    const keys = ['x', 'y', 'size', 'speed', 'phase', 'spin', 'rotation', 'sway'];
    particles = storedScene.particles.slice(0, 44).filter(p => p && keys.every(key => Number.isFinite(p[key])) && p.x >= -.2 && p.x <= 1.2 && p.y >= -.2 && p.y <= 1.2);
    elapsed = Number.isFinite(storedScene.elapsed) ? storedScene.elapsed : 0;
  }
  function saveScene() { write(sessionStorage, sceneKey, { season, elapsed, particles }); }
  function resize() {
    width = innerWidth; height = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, constrained ? 1 : 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(constrained ? 20 : 44, Math.max(12, Math.round(width * height / 36000)));
    while (particles.length < count) particles.push(makeParticle());
    particles.length = count;
    draw(0);
  }
  function draw(dt) {
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      const sway = Math.sin(elapsed * .65 + p.phase);
      p.x += sway * p.sway * dt / width;
      p.y += (season === 'summer' ? Math.sin(elapsed * .3 + p.phase) * 3 : p.speed * (season === 'winter' ? .55 : 1)) * dt / height;
      p.rotation += p.spin * dt;
      if (p.y > 1.03) { p.y = -.03; p.x = Math.random(); }
      if (p.y < -.04) p.y = 1.02;
      if (p.x > 1.03) p.x = -.03;
      if (p.x < -.03) p.x = 1.03;
      ctx.save(); ctx.translate(p.x * width, p.y * height);
      const s = p.size;
      ctx.globalAlpha = .65;
      if (season === 'summer') {
        ctx.globalAlpha = .22 + .7 * (Math.sin(elapsed * .8 + p.phase) + 1) / 2;
        ctx.fillStyle = '#d9f99d'; ctx.beginPath(); ctx.arc(0, 0, s * .45, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha *= .18; ctx.beginPath(); ctx.arc(0, 0, s * 1.6, 0, Math.PI * 2); ctx.fill();
      } else if (season === 'winter') {
        ctx.fillStyle = p.phase < Math.PI ? '#fff' : '#dbeeff'; ctx.beginPath(); ctx.arc(0, 0, s * .5, 0, Math.PI * 2); ctx.fill();
        if (s > 4) { ctx.strokeStyle = '#e5f3ff'; ctx.lineWidth = .65; ctx.rotate(p.rotation); ctx.beginPath(); for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; ctx.moveTo(-Math.cos(a) * s, -Math.sin(a) * s); ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s); } ctx.stroke(); }
      } else {
        ctx.rotate(p.rotation + sway * .35);
        ctx.scale(.65 + Math.abs(Math.cos(p.rotation)) * .35, 1);
        ctx.fillStyle = season === 'spring' ? (p.phase < Math.PI ? '#ffd7e6' : '#fff2f6') : ['#f4bd67', '#dc8b47', '#bc8559'][Math.floor(p.phase / (Math.PI * 2) * 3)];
        ctx.beginPath(); ctx.moveTo(0, -s); ctx.bezierCurveTo(s * 1.3, -s * .4, s, s, 0, s * 1.5); ctx.bezierCurveTo(-s, s * .4, -s, -s * .5, 0, -s); ctx.fill();
        if (season === 'autumn') { ctx.strokeStyle = '#8e633b'; ctx.lineWidth = .6; ctx.beginPath(); ctx.moveTo(0, -s * .7); ctx.lineTo(0, s * 1.6); ctx.stroke(); }
      }
      ctx.restore();
    }
  }
  function tick(now) {
    frame = 0;
    if (!started || document.hidden || reduced.matches || mode === 'off') return;
    if (!last || now - last >= interval) {
      const dt = last ? Math.min((now - last) / 1000, .08) : 0;
      last = now; elapsed += dt;
      if (mode === 'auto' && now >= nextSeasonCheck) { nextSeasonCheck = now + 60000; season = seasonForDate(); updateHint(); }
      draw(dt);
    }
    frame = requestAnimationFrame(tick);
  }
  function updateHint() {
    canvas.dataset.season = season;
    hint.textContent = reduced.matches ? '系统已开启减少动态效果，粒子已暂停。' : mode === 'off' ? '粒子已关闭。仅此账号在当前浏览器生效。' : `${mode === 'auto' ? '当前：' : ''}${LABELS[season]} · 自动保存，仅首页生效。`;
  }
  function sync() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    canvas.hidden = mode === 'off' || reduced.matches;
    updateHint();
    if (!canvas.hidden && !document.hidden && started) { draw(0); frame = requestAnimationFrame(tick); }
  }
  function setMode(value) {
    mode = MODES.includes(value) ? value : 'auto'; select.value = mode;
    season = mode === 'auto' || mode === 'off' ? seasonForDate() : mode;
    // Retain positions when changing themes instead of restarting the entire scene.
    sync(); saveScene();
  }
  select.addEventListener('change', () => { setMode(select.value); write(localStorage, preferenceKey, mode); });
  window.addEventListener('storage', event => { if (event.key === preferenceKey) setMode(read(localStorage, preferenceKey)); });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  window.addEventListener('pagehide', () => { started = false; saveScene(); cancelAnimationFrame(frame); frame = 0; });
  window.addEventListener('pageshow', () => { started = true; sync(); });
  resize(); sync();
}
