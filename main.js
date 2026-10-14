/*
 * NEBULA - an interactive particle universe.
 *
 * How it works, in short:
 *   1. Thousands of particles live in typed arrays (fast!).
 *   2. Every frame, each particle gets pushed by forces (gravity, a flow
 *      field, a vortex, shockwaves) which change its velocity and position.
 *   3. We draw each particle as a short glowing line. Instead of clearing the
 *      screen, we paint a faint dark layer over it, which creates the trails.
 *
 * Everything is plain JavaScript. No libraries, no build step.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * Setup
   * ---------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const canvas = $('sky');
  const ctx = canvas.getContext('2d', { alpha: false });
  const root = document.documentElement;

  const TAU = Math.PI * 2;
  const MAX_PARTICLES = 14000;
  const BUCKETS = 32;          // particles are drawn in colour groups
  const MAX_SPEED = 14;
  const G = 4000;              // gravity strength
  const SOFT = 3600;           // softening so gravity never explodes at d = 0

  let W = 0, H = 0, DPR = 1, CX = 0, CY = 0;

  // Particle data, stored in flat arrays for speed.
  const px = new Float32Array(MAX_PARTICLES);
  const py = new Float32Array(MAX_PARTICLES);
  const vx = new Float32Array(MAX_PARTICLES);
  const vy = new Float32Array(MAX_PARTICLES);
  const bucketOf = new Uint8Array(MAX_PARTICLES);
  const order = new Uint16Array(MAX_PARTICLES);
  const starts = new Uint32Array(BUCKETS + 1);
  const cursor = new Uint32Array(BUCKETS);

  let n = 6000; // how many particles are alive

  /* ------------------------------------------------------------------
   * Colour palettes. Each one is a gradient of [hue, saturation, lightness].
   * ---------------------------------------------------------------- */
  const PALETTES = [
    { name: 'Aurora', bg: [5, 11, 22],  stops: [[152, 90, 60], [190, 92, 60], [258, 85, 68], [312, 80, 66]] },
    { name: 'Ember',  bg: [18, 6, 10],  stops: [[-8, 90, 56], [14, 96, 58], [36, 100, 60], [52, 100, 74]] },
    { name: 'Frost',  bg: [6, 10, 20],  stops: [[200, 40, 96], [212, 70, 82], [232, 75, 72], [262, 70, 70]] },
    { name: 'Candy',  bg: [16, 7, 26],  stops: [[322, 95, 66], [282, 90, 72], [200, 95, 66], [58, 100, 70]] }
  ];

  let palIdx = 0;
  let pal = PALETTES[0];
  let colors = [];
  let fadeAlpha = 0.1;
  let fadeStyle = '';

  function buildColors(p) {
    const out = [];
    const last = p.stops.length - 1;
    for (let b = 0; b < BUCKETS; b++) {
      const t = ((b + 0.5) / BUCKETS) * last;
      const i = Math.min(last - 1, Math.floor(t));
      const f = t - i;
      const a = p.stops[i], c = p.stops[i + 1];
      const h = a[0] + (c[0] - a[0]) * f;
      const s = a[1] + (c[1] - a[1]) * f;
      const l = a[2] + (c[2] - a[2]) * f;
      out.push(`hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,0.8)`);
    }
    return out;
  }

  function updateFadeStyle() {
    fadeStyle = `rgba(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]},${fadeAlpha})`;
  }

  /* ------------------------------------------------------------------
   * Modes
   * ---------------------------------------------------------------- */
  const MODES = {
    galaxy:  { id: 0, friction: 0.9996, hint: 'Your cursor is a second star. Click to send a shockwave.' },
    flow:    { id: 1, friction: 0.945,  hint: 'Move to push the current. Hold to pull it in instead.' },
    gravity: { id: 2, friction: 0.9992, hint: 'Click to plant a black hole. Press C to clear them.' },
    storm:   { id: 3, friction: 0.955,  hint: 'The storm follows you. Hold to tighten it.' }
  };
  let modeKey = 'galaxy';
  let mode = MODES.galaxy;

  /* ------------------------------------------------------------------
   * Input state
   * ---------------------------------------------------------------- */
  const target = { x: 0, y: 0 };   // where the pointer really is
  const P = { x: 0, y: 0 };        // smoothed pointer (or autopilot) position
  let pressed = false;
  let lastMove = -1e9;

  const waves = [];                // expanding shockwave rings
  const holes = [];                // black holes placed by the player

  /* ------------------------------------------------------------------
   * Sizing
   * ---------------------------------------------------------------- */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    CX = W / 2;
    CY = H / 2;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = `rgb(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]})`;
    ctx.fillRect(0, 0, W, H);
  }

  /* ------------------------------------------------------------------
   * Seeding: where particles start when you switch modes
   * ---------------------------------------------------------------- */
  function orbitSpeed(d) {
    // Speed needed for a circular orbit at distance d from a star.
    return Math.sqrt((G * d * d) / Math.pow(d * d + SOFT, 1.5));
  }

  function seed(key) {
    const R = Math.min(W, H) * 0.46;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (key === 'galaxy') {
        const r = 12 + Math.pow(Math.random(), 0.65) * R;
        const arm = (i % 2) * Math.PI;                       // two spiral arms
        const scatter = (Math.random() + Math.random() + Math.random() - 1.5) * 0.5;
        const a = arm + r * 0.011 + scatter * (0.4 + r / R);
        const s = orbitSpeed(r) * (0.92 + Math.random() * 0.12);
        px[i] = CX + Math.cos(a) * r;
        py[i] = CY + Math.sin(a) * r;
        vx[i] = -Math.sin(a) * s;
        vy[i] = Math.cos(a) * s;
      } else {
        px[i] = Math.random() * W;
        py[i] = Math.random() * H;
        const s = key === 'gravity' ? 0.6 : 0;
        vx[i] = (Math.random() - 0.5) * s;
        vy[i] = (Math.random() - 0.5) * s;
      }
    }
  }

  /* ------------------------------------------------------------------
   * A cheap, smooth, swirly "noise" field used by Flow and Storm
   * ---------------------------------------------------------------- */
  function flowAngle(x, y, t) {
    return (
      Math.sin(x * 0.0021 + t * 0.3) +
      Math.cos(y * 0.0027 - t * 0.2) +
      Math.sin((x + y) * 0.0016 + t * 0.15) * 1.2 +
      Math.cos(Math.hypot(x - CX, y - CY) * 0.003 - t * 0.4)
    ) * 1.6;
  }

  /* ------------------------------------------------------------------
   * Sound (Web Audio). Created only after the first click on Sound.
   * ---------------------------------------------------------------- */
  const audio = { ctx: null, on: false, master: null, bus: null, filter: null };

  function initAudio() {
    if (audio.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    audio.ctx = ac;

    const master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);
    audio.master = master;

    // Notes go through an echo for that spacey sound.
    const bus = ac.createGain();
    const delay = ac.createDelay(1.0);
    delay.delayTime.value = 0.34;
    const feedback = ac.createGain();
    feedback.gain.value = 0.42;
    const wet = ac.createGain();
    wet.gain.value = 0.45;
    bus.connect(master);
    bus.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(master);
    audio.bus = bus;

    // A low drone whose brightness follows how fast the particles move.
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 6;
    const droneGain = ac.createGain();
    droneGain.gain.value = 0.05;
    [55, 82.41, 110.5].forEach((f) => {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 16;
      o.connect(filter);
      o.start();
    });
    filter.connect(droneGain);
    droneGain.connect(master);
    audio.filter = filter;
  }

  const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic: always sounds good

  function playNote(xNorm) {
    if (!audio.on || !audio.ctx) return;
    const ac = audio.ctx;
    const idx = Math.max(0, Math.min(14, Math.floor(xNorm * 15)));
    const midi = 57 + Math.floor(idx / 5) * 12 + SCALE[idx % 5];
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const now = ac.currentTime;

    [[freq, 'triangle', 0.22], [freq * 2, 'sine', 0.08]].forEach(([f, type, vol]) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(vol, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
      o.connect(g);
      g.connect(audio.bus);
      o.start(now);
      o.stop(now + 1.6);
    });
  }

  /* ------------------------------------------------------------------
   * Player actions
   * ---------------------------------------------------------------- */
  function burst(x, y) {
    waves.push({ x, y, age: 0 });
    if (waves.length > 6) waves.shift();
    if (modeKey === 'gravity') {
      holes.push({ x, y });
      if (holes.length > 6) holes.shift();
    }
    playNote(x / W);
  }

  /* ------------------------------------------------------------------
   * UI wiring
   * ---------------------------------------------------------------- */
  const hintEl = $('hint');
  const modeBtns = Array.from(document.querySelectorAll('[data-mode]'));
  const countInput = $('count');
  const trailInput = $('trail');
  const swEl = $('sw');
  const palNameEl = $('palName');
  const btnSound = $('btnSound');
  const statN = $('statN');
  const statFps = $('statFps');
  let hintTimer = null;

  function showHint(text, ms) {
    hintEl.textContent = text;
    hintEl.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('show'), ms || 5000);
  }

  function setMode(key, announce) {
    modeKey = key;
    mode = MODES[key];
    modeBtns.forEach((b) => {
      const on = b.dataset.mode === key;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    holes.length = 0;
    waves.length = 0;
    seed(key);
    if (announce) showHint(mode.hint);
  }

  function setPalette(i) {
    palIdx = (i + PALETTES.length) % PALETTES.length;
    pal = PALETTES[palIdx];
    colors = buildColors(pal);
    updateFadeStyle();

    const css = pal.stops.map((s) => `hsl(${s[0]},${s[1]}%,${s[2]}%)`).join(',');
    swEl.style.background = `linear-gradient(90deg,${css})`;
    palNameEl.textContent = pal.name;

    const mid = pal.stops[1];
    const bg = `rgb(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]})`;
    root.style.setProperty('--accent', `hsl(${mid[0]},${mid[1]}%,${mid[2]}%)`);
    root.style.setProperty('--bg', bg);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);

    // A quick wash so the new background shows up right away.
    ctx.fillStyle = `rgba(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]},0.5)`;
    ctx.fillRect(0, 0, W, H);
  }

  function setTrail(value) {
    // 0 = very short trails, 100 = very long trails
    fadeAlpha = 0.5 * Math.pow(0.07, value / 100);
    updateFadeStyle();
  }

  function toggleSound() {
    initAudio();
    if (!audio.ctx) return;
    audio.on = !audio.on;
    audio.ctx.resume();
    audio.master.gain.setTargetAtTime(audio.on ? 0.8 : 0, audio.ctx.currentTime, 0.08);
    btnSound.setAttribute('aria-pressed', String(audio.on));
    btnSound.textContent = audio.on ? 'Sound on' : 'Sound off';
  }

  function saveImage() {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nebula-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (root.requestFullscreen) {
      root.requestFullscreen();
    }
  }

  function setHidden(hidden) {
    document.body.classList.toggle('ui-hidden', hidden);
  }

  modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, true)));
  countInput.addEventListener('input', () => { n = Number(countInput.value); });
  trailInput.addEventListener('input', () => setTrail(Number(trailInput.value)));
  $('btnPalette').addEventListener('click', () => setPalette(palIdx + 1));
  btnSound.addEventListener('click', toggleSound);
  $('btnSave').addEventListener('click', saveImage);
  $('btnFull').addEventListener('click', toggleFullscreen);
  $('btnHide').addEventListener('click', () => setHidden(true));
  $('btnShow').addEventListener('click', () => setHidden(false));

  // Pointer (mouse, touch and pen all work the same way)
  window.addEventListener('pointermove', (e) => {
    target.x = e.clientX;
    target.y = e.clientY;
    lastMove = performance.now();
  });

  canvas.addEventListener('pointerdown', (e) => {
    pressed = true;
    target.x = P.x = e.clientX;
    target.y = P.y = e.clientY;
    lastMove = performance.now();
    burst(e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', () => { pressed = false; });
  window.addEventListener('pointercancel', () => { pressed = false; });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'BUTTON' || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === '1') setMode('galaxy', true);
    else if (k === '2') setMode('flow', true);
    else if (k === '3') setMode('gravity', true);
    else if (k === '4') setMode('storm', true);
    else if (k === 'p') setPalette(palIdx + 1);
    else if (k === 's') toggleSound();
    else if (k === 'h') setHidden(!document.body.classList.contains('ui-hidden'));
    else if (k === 'f') toggleFullscreen();
    else if (k === 'c') holes.length = 0;
    else if (k === ' ') { e.preventDefault(); burst(P.x, P.y); }
  });

  window.addEventListener('resize', resize);

  /* ------------------------------------------------------------------
   * The main loop
   * ---------------------------------------------------------------- */
  let t = 0;
  let lastT = performance.now();
  let fpsEma = 60, lowCount = 0, lastStat = 0;

  // Attractors (things that pull particles in) are rebuilt every frame.
  const attX = new Float32Array(16);
  const attY = new Float32Array(16);
  const attM = new Float32Array(16);
  let na = 0;

  function addAttractor(x, y, m) {
    attX[na] = x; attY[na] = y; attM[na] = m; na++;
  }

  function buildAttractors() {
    na = 0;
    const hold = pressed ? 3 : 1;

    if (modeKey === 'galaxy') {
      addAttractor(CX, CY, 1);
      addAttractor(P.x, P.y, 0.35 * hold);
    } else if (modeKey === 'gravity') {
      // Three "ghost suns" drift around so the sky is alive before you touch it.
      addAttractor(CX + Math.cos(t * 0.23) * W * 0.30,       CY + Math.sin(t * 0.31) * H * 0.26, 0.7);
      addAttractor(CX + Math.cos(t * 0.19 + 2.1) * W * 0.24, CY + Math.sin(t * 0.27 + 1.3) * H * 0.30, 0.7);
      addAttractor(CX + Math.cos(t * 0.13 + 4.2) * W * 0.34, CY + Math.sin(t * 0.17 + 3.0) * H * 0.20, 0.7);
      for (let k = 0; k < holes.length; k++) addAttractor(holes[k].x, holes[k].y, 1.6);
      addAttractor(P.x, P.y, 0.6 * hold);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);

    const rawDt = now - lastT;
    lastT = now;
    const dt = Math.min(2.2, rawDt / 16.667) || 1;
    t += Math.min(rawDt, 50) / 1000;

    // Pointer: follow the real one, or wander on autopilot when idle.
    const idle = now - lastMove > 2500;
    if (idle) {
      target.x = CX + Math.cos(t * 0.21) * W * 0.28;
      target.y = CY + Math.sin(t * 0.33) * H * 0.28;
    }
    const follow = idle ? 0.04 : 0.25;
    P.x += (target.x - P.x) * follow;
    P.y += (target.y - P.y) * follow;

    buildAttractors();

    // Shockwaves grow outward and fade.
    for (let k = waves.length - 1; k >= 0; k--) {
      waves[k].age += dt;
      if (waves[k].age > 80) waves.splice(k, 1);
    }

    const friction = Math.pow(mode.friction, dt);
    const id = mode.id;
    const view = Math.min(W, H) * 0.5;
    const tight = pressed ? 1.8 : 1;
    let speedSum = 0, speedCount = 0;

    /* ---- physics ---- */
    for (let i = 0; i < n; i++) {
      let x = px[i], y = py[i], u = vx[i], v = vy[i];
      let ax = 0, ay = 0, val = 0;

      if (id === 0 || id === 2) {
        // Gravity from every attractor.
        for (let k = 0; k < na; k++) {
          const dx = attX[k] - x, dy = attY[k] - y;
          const s = dx * dx + dy * dy + SOFT;
          const inv = (G * attM[k]) / (s * Math.sqrt(s));
          ax += dx * inv;
          ay += dy * inv;
        }
        if (id === 0) {
          const dxc = x - CX, dyc = y - CY;
          val = Math.sqrt(dxc * dxc + dyc * dyc) / view;
        }
      } else if (id === 1) {
        // Flow field + pointer that pushes (or pulls when pressed).
        const ang = flowAngle(x, y, t);
        ax = Math.cos(ang) * 0.11;
        ay = Math.sin(ang) * 0.11;
        const dx = x - P.x, dy = y - P.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 48400) {
          const d = Math.sqrt(d2) + 0.5;
          const q = 1 - d / 220;
          const f = q * q * 0.9 * (pressed ? -1.6 : 1);
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        }
        const w = ((ang * 0.1 + t * 0.03) % 2 + 2) % 2;
        val = Math.abs(w - 1);
      } else {
        // Storm: a vortex that spins around the pointer and forms a ring.
        const dx = P.x - x, dy = P.y - y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.5;
        const fall = 0.25 + 0.75 / (1 + d / 260);
        const rx = dx / d, ry = dy / d;
        const radial = ((d - 90) / (d + 90)) * 0.07 * fall * tight;
        const spin = 0.16 * fall * tight;
        const ang = flowAngle(x, y, t);
        ax = rx * radial - ry * spin + Math.cos(ang) * 0.04;
        ay = ry * radial + rx * spin + Math.sin(ang) * 0.04;
      }

      // Shockwaves: particles on the ring get shoved outward.
      for (let k = 0; k < waves.length; k++) {
        const w = waves[k];
        const dx = x - w.x, dy = y - w.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const diff = d - w.age * 11;
        if (diff > -55 && diff < 55) {
          const f = (1 - Math.abs(diff) / 55) * (1 - w.age / 80);
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        }
      }

      u = (u + ax * dt) * friction;
      v = (v + ay * dt) * friction;

      const sp2 = u * u + v * v;
      if (sp2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(sp2);
        u *= k; v *= k;
      }
      if (id >= 2) val = Math.sqrt(sp2) / 7;
      if ((i & 15) === 0) { speedSum += Math.sqrt(sp2); speedCount++; }

      x += u * dt;
      y += v * dt;
      if (x < 0 || x >= W) x = ((x % W) + W) % W;
      if (y < 0 || y >= H) y = ((y % H) + H) % H;

      px[i] = x; py[i] = y; vx[i] = u; vy[i] = v;

      let b = (val * BUCKETS) | 0;
      if (b < 0) b = 0; else if (b >= BUCKETS) b = BUCKETS - 1;
      bucketOf[i] = b;
    }

    /* ---- drawing ---- */
    // 1) Fade the previous frame a little. This is what makes the trails.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = fadeStyle;
    ctx.fillRect(0, 0, W, H);

    // 2) Sort particles into colour buckets (counting sort) so we can
    //    draw each colour with a single stroke() call. Much faster.
    starts.fill(0);
    for (let i = 0; i < n; i++) starts[bucketOf[i] + 1]++;
    for (let b = 0; b < BUCKETS; b++) starts[b + 1] += starts[b];
    for (let b = 0; b < BUCKETS; b++) cursor[b] = starts[b];
    for (let i = 0; i < n; i++) order[cursor[bucketOf[i]]++] = i;

    // 3) Draw glowing lines (additive blending makes overlaps brighter).
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    for (let b = 0; b < BUCKETS; b++) {
      const s = starts[b], e = starts[b + 1];
      if (s === e) continue;
      ctx.strokeStyle = colors[b];
      ctx.beginPath();
      for (let k = s; k < e; k++) {
        const i = order[k];
        const x = px[i], y = py[i];
        ctx.moveTo(x - vx[i] * 1.6, y - vy[i] * 1.6);
        ctx.lineTo(x + 0.01, y);
      }
      ctx.stroke();
    }

    // 4) Shockwave rings and black holes on top.
    ctx.globalCompositeOperation = 'source-over';
    for (let k = 0; k < waves.length; k++) {
      const w = waves[k];
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.age * 11, 0, TAU);
      ctx.strokeStyle = `rgba(255,255,255,${(0.35 * (1 - w.age / 80)).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    for (let k = 0; k < holes.length; k++) {
      const h = holes[k];
      const pulse = 1 + 0.15 * Math.sin(t * 4 + k);
      ctx.beginPath();
      ctx.arc(h.x, h.y, 6 * pulse, 0, TAU);
      ctx.fillStyle = `rgb(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]})`;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colors[BUCKETS - 1];
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.x, h.y, 20 * pulse, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.stroke();
    }

    /* ---- sound follows the motion ---- */
    if (audio.on && audio.filter && speedCount) {
      const avg = speedSum / speedCount;
      audio.filter.frequency.setTargetAtTime(160 + avg * 140, audio.ctx.currentTime, 0.1);
    }

    /* ---- stats + automatic quality control ---- */
    if (rawDt < 250) fpsEma += (1000 / rawDt - fpsEma) * 0.05;
    if (now - lastStat > 500) {
      lastStat = now;
      statN.textContent = `${n.toLocaleString()} particles`;
      statFps.textContent = `${Math.round(fpsEma)} fps`;
      if (fpsEma < 38 && n > 2500) {
        lowCount++;
        if (lowCount >= 4) {
          n = Math.max(2500, Math.floor((n * 0.8) / 100) * 100);
          countInput.value = n;
          lowCount = 0;
        }
      } else {
        lowCount = 0;
      }
    }
  }

  /* ------------------------------------------------------------------
   * Start
   * ---------------------------------------------------------------- */
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  resize();
  n = Math.min(9000, Math.max(2500, Math.round((W * H) / 260 / 100) * 100));
  countInput.value = n;
  trailInput.value = reduceMotion ? 15 : 62;
  setTrail(Number(trailInput.value));
  target.x = P.x = CX;
  target.y = P.y = CY;
  setPalette(0);
  setMode('galaxy', false);
  showHint(MODES.galaxy.hint, 7000);
  requestAnimationFrame(frame);
})();
