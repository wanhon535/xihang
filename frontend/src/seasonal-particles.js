const MODES = ['auto', 'spring', 'summer', 'autumn', 'winter', 'off'];
const LABELS = { spring: '春 · 花瓣柳絮', summer: '夏 · 萤火流光', autumn: '秋 · 落叶', winter: '冬 · 飘雪' };
let activeRuntime = null;

export function seasonForDate(date = new Date()) {
  return ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][date.getMonth()];
}

export function mountSeasonalParticles() {
  if (!document.body.classList.contains('vben-shell') || activeRuntime) return activeRuntime;

  const controls = document.querySelector('.theme-controls-grid');
  if (!controls) return null;

  const ambient = document.createElement('div');
  ambient.id = 'appAmbientLayer';
  ambient.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  canvas.id = 'seasonalParticles';
  canvas.setAttribute('aria-hidden', 'true');
  ambient.append(canvas);
  document.body.prepend(ambient);

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    ambient.remove();
    return null;
  }

  const field = document.createElement('label');
  field.className = 'field seasonal-setting';
  field.innerHTML = '<span>工作区季节氛围</span><select class="field-input" id="seasonalMode" aria-describedby="seasonalHint"><option value="auto">跟随季节（自动）</option><option value="spring">春 · 花瓣柳絮</option><option value="summer">夏 · 萤火流光</option><option value="autumn">秋 · 落叶</option><option value="winter">冬 · 飘雪</option><option value="off">关闭粒子效果</option></select><small id="seasonalHint" class="muted"></small>';
  controls.append(field);

  const select = field.querySelector('select');
  const hint = field.querySelector('small');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const constrained = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 2;
  const interval = 1000 / (constrained ? 20 : 24);
  const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch {} };
  let userId = 'anonymous';
  let preferenceKey = `tidesail.particles.${userId}`;
  let sceneKey = `${preferenceKey}.scene`;
  let mode = 'auto';
  let season = seasonForDate();
  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let frame = 0;
  let last = 0;
  let nextSeasonCheck = 0;
  let started = true;
  let elapsed = 0;

  function readMode() {
    const stored = read(localStorage, preferenceKey);
    return MODES.includes(stored) ? stored : 'auto';
  }

  function loadScene() {
    particles = [];
    elapsed = 0;
    const storedScene = read(sessionStorage, sceneKey);
    if (storedScene?.season !== season || !Array.isArray(storedScene.particles)) return;
    const keys = ['x', 'y', 'size', 'speed', 'phase', 'spin', 'rotation', 'sway'];
    particles = storedScene.particles.slice(0, 44).filter(p => p && keys.every(key => Number.isFinite(p[key])) && p.x >= -.2 && p.x <= 1.2 && p.y >= -.2 && p.y <= 1.2);
    elapsed = Number.isFinite(storedScene.elapsed) ? storedScene.elapsed : 0;
  }

  function saveScene() {
    write(sessionStorage, sceneKey, { season, elapsed, particles });
  }

  function makeParticle() {
    return { x: Math.random(), y: Math.random(), size: 1.5 + Math.random() * 3.5, speed: 8 + Math.random() * 15, phase: Math.random() * Math.PI * 2, spin: (Math.random() - .5) * .8, rotation: Math.random() * Math.PI * 2, sway: 3 + Math.random() * 8 };
  }

  function resize() {
    width = innerWidth;
    height = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, constrained ? 1 : 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(constrained ? 36 : 90, Math.max(20, Math.round(width * height / 16000)));
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
      ctx.save();
      ctx.translate(p.x * width, p.y * height);
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
    hint.textContent = reduced.matches ? '系统已开启减少动态效果，粒子已暂停。' : mode === 'off' ? '粒子已关闭。仅此账号在当前浏览器生效。' : `${mode === 'auto' ? '当前：' : ''}${LABELS[season]} · 自动保存，所有内部页面生效。`;
  }

  function sync() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    canvas.hidden = mode === 'off' || reduced.matches;
    updateHint();
    if (!canvas.hidden && !document.hidden && started) { draw(0); frame = requestAnimationFrame(tick); }
  }

  function setUser(user) {
    userId = user?.id == null ? 'anonymous' : String(user.id);
    preferenceKey = `tidesail.particles.${userId}`;
    sceneKey = `${preferenceKey}.scene`;
    mode = readMode();
    select.value = mode;
    season = mode === 'auto' || mode === 'off' ? seasonForDate() : mode;
    loadScene();
    resize();
    sync();
  }

  select.addEventListener('change', () => { mode = MODES.includes(select.value) ? select.value : 'auto'; season = mode === 'auto' || mode === 'off' ? seasonForDate() : mode; sync(); saveScene(); write(localStorage, preferenceKey, mode); });
  window.addEventListener('storage', event => { if (event.key === preferenceKey) setUser({ id: userId }); });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  window.addEventListener('pagehide', () => { started = false; saveScene(); cancelAnimationFrame(frame); frame = 0; });
  window.addEventListener('pageshow', () => { started = true; sync(); });

  activeRuntime = { setUser };
  mode = readMode();
  select.value = mode;
  season = mode === 'auto' || mode === 'off' ? seasonForDate() : mode;
  loadScene();
  resize();
  sync();
  return activeRuntime;
}

export function setSeasonalParticleUser(user) {
  const runtime = activeRuntime || mountSeasonalParticles();
  runtime?.setUser(user);
}
