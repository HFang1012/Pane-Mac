// Tweak's editor. One module per kind of file (picture, video, sound, words) builds the stage and the tools
// on the right, keeps its edits in `state`, and turns them into a save job. Undo, the save bar and the
// toast are shared. Pictures are drawn and encoded here on a canvas; video and sound are cut by the main
// process (AVFoundation, through native/pane-files); words go back as text.
const $ = (id) => document.getElementById(id);
const stage = $('stage'), panel = $('panel');
const DPR = () => window.devicePixelRatio || 1;
$('glyph').innerHTML = Tools.glyph('tweak', 20);

let F = null; // the file, as the main process read it
let K = null; // the module for its kind
let state = null; // its edits
let base = ''; // state when opened (or last saved), to tell if anything changed
const hist = { past: [], future: [] };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
const fmtTime = (s, tenths = true) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${(tenths ? r.toFixed(1) : String(Math.floor(r))).padStart(tenths ? 4 : 2, '0')}`;
};
const I = {
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  left: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  right: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  flipH: '<path d="M12 3v18"/><path d="M8 7 3 12l5 5V7zM16 7l5 5-5 5V7z"/>',
  flipV: '<path d="M3 12h18"/><path d="M7 8l5-5 5 5H7zM7 16l5 5 5-5H7z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.5-2h5L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.4"/>',
  note: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
  cols: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15M15 4.5v15"/>',
  gallery: '<rect x="3.5" y="4" width="17" height="11" rx="2.5"/><rect x="3.5" y="17.5" width="4" height="3" rx="1"/><rect x="10" y="17.5" width="4" height="3" rx="1"/><rect x="16.5" y="17.5" width="4" height="3" rx="1"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.5l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z"/>',
};
const icon = (k, w = 2.2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

// ---------- shared bits of the inspector ----------
function group(title, extra = '') {
  const g = el('div', 'group');
  g.style.setProperty('--i', panel.children.length); // the cards settle in one after another
  g.append(el('h3', '', `<span>${title}</span>${extra}`));
  panel.append(g);
  return g;
}
function button(label, onClick, cls = 'tbtn') {
  const b = el('button', cls, label);
  b.addEventListener('click', (e) => { e.currentTarget.blur(); onClick(e); });
  return b;
}
function slider(parent, { label, min, max, step = 1, value, unit = '', fmt, onInput, onChange }) {
  const wrap = el('div', 'slider');
  const id = `s${Math.random().toString(36).slice(2, 8)}`;
  wrap.innerHTML = `<label for="${id}">${label}</label><output></output><input type="range" id="${id}" min="${min}" max="${max}" step="${step}">`;
  const input = wrap.querySelector('input'), out = wrap.querySelector('output');
  const show = (v) => { out.textContent = fmt ? fmt(v) : `${Math.round(v)}${unit}`; input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`); };
  input.value = value; show(value);
  input.addEventListener('input', () => { show(+input.value); onInput?.(+input.value); });
  input.addEventListener('change', () => onChange?.(+input.value));
  input.addEventListener('dblclick', () => { input.value = wrap.dataset.reset ?? value; show(+input.value); onInput?.(+input.value); onChange?.(+input.value); });
  wrap.dataset.reset = value;
  parent.append(wrap);
  return { set: (v) => { input.value = v; show(v); }, el: wrap };
}
function switchLine(parent, label, on, onToggle) {
  const line = el('label', 'switchline', `<span>${label}</span>`);
  const sw = el('button', 'sw');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', on);
  sw.setAttribute('aria-label', label);
  sw.addEventListener('click', () => { const v = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', v); onToggle(v); });
  line.append(sw);
  parent.append(line);
  return { set: (v) => sw.setAttribute('aria-checked', v) };
}

// ---------- undo ----------
function commit(next, before = state) {
  hist.past.push(JSON.stringify(before));
  if (hist.past.length > 200) hist.past.shift();
  hist.future = [];
  state = next;
  K.apply();
  changed();
}
function undo(dir) {
  if (K?.text) { $('text').focus(); document.execCommand(dir === 'undo' ? 'undo' : 'redo'); return; }
  const from = dir === 'undo' ? hist.past : hist.future, to = dir === 'undo' ? hist.future : hist.past;
  if (!from.length) return;
  to.push(JSON.stringify(state));
  state = JSON.parse(from.pop());
  K.apply();
  changed();
}
$('undo').addEventListener('click', () => undo('undo'));
$('redo').addEventListener('click', () => undo('redo'));
function isDirty() {
  if (!F || !K) return false;
  if (K.noSave) return $('stem').value.trim() !== F.stem;
  return (K.dirty ? K.dirty() : JSON.stringify(state) !== base) || $('stem').value.trim() !== F.stem || ending() !== F.def;
}
function changed() {
  $('dirty').classList.toggle('on', isDirty());
  if (!K?.text) { $('undo').disabled = !hist.past.length; $('redo').disabled = !hist.future.length; }
  describeSave();
  K?.estimateSoon?.();
}

// A slider that changes `state` as it moves and lands as one undo step when let go.
function liveEdit() {
  let pre = null;
  return {
    input(next) { pre ??= JSON.stringify(state); state = next; },
    done() { if (pre && pre !== JSON.stringify(state)) { hist.past.push(pre); hist.future = []; changed(); } pre = null; },
  };
}

// ---------- crop box (pictures and video share it) ----------
// `get()` / `set(rect)` work in the picture's own pixels; `scale` is screen px per picture px.
function cropBox(host, { size, get, set, begin, end, ratio }) {
  const c = el('div', 'crop', '<div class="box"><i class="h" data-h="nw"></i><i class="h" data-h="ne"></i><i class="h" data-h="sw"></i><i class="h" data-h="se"></i><i class="e" data-h="n"></i><i class="e" data-h="s"></i><i class="e" data-h="w"></i><i class="e" data-h="e"></i><span class="dims"></span></div>');
  host.append(c);
  const box = c.querySelector('.box');
  let scale = 1;
  function place() {
    const { w: W, h: H } = size();
    const r = get() || { x: 0, y: 0, w: W, h: H };
    Object.assign(box.style, { left: `${r.x * scale}px`, top: `${r.y * scale}px`, width: `${r.w * scale}px`, height: `${r.h * scale}px` });
    box.querySelector('.dims').textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    c.hidden = !c.classList.contains('live') && !get();
  }
  box.addEventListener('pointerdown', (e) => {
    if (!c.classList.contains('live')) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const h = e.target.dataset.h || 'move';
    const { w: W, h: H } = size();
    const r0 = { ...(get() || { x: 0, y: 0, w: W, h: H }) };
    const x0 = e.clientX, y0 = e.clientY;
    const ar = ratio();
    begin?.();
    c.classList.add('moving');
    const move = (ev) => {
      const dx = (ev.clientX - x0) / scale, dy = (ev.clientY - y0) / scale;
      let { x, y, w, h: hh } = r0;
      if (h === 'move') { x = clamp(x + dx, 0, W - w); y = clamp(y + dy, 0, H - hh); }
      else {
        if (h.includes('w')) { x = clamp(r0.x + dx, 0, r0.x + r0.w - 8); w = r0.x + r0.w - x; }
        if (h.includes('e')) w = clamp(r0.w + dx, 8, W - r0.x);
        if (h.includes('n')) { y = clamp(r0.y + dy, 0, r0.y + r0.h - 8); hh = r0.y + r0.h - y; }
        if (h.includes('s')) hh = clamp(r0.h + dy, 8, H - r0.y);
        if (ar) { // keep the shape: the side you dragged leads
          if (h === 'n' || h === 's') w = hh * ar; else hh = w / ar;
          if (x + w > W) { w = W - x; hh = w / ar; }
          if (y + hh > H) { hh = H - y; w = hh * ar; }
          if (h.includes('n')) y = r0.y + r0.h - hh;
          if (h.includes('w')) x = r0.x + r0.w - w;
        }
      }
      set({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) });
      place();
    };
    const up = () => { box.removeEventListener('pointermove', move); c.classList.remove('moving'); end?.(); };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up, { once: true });
    box.addEventListener('pointercancel', up, { once: true });
  });
  return {
    el: c,
    live: (on) => { c.classList.toggle('live', on); place(); },
    isLive: () => c.classList.contains('live'),
    place: (s) => { if (s) scale = s; place(); },
  };
}
const ASPECTS = [['Free', 0], ['Original', -1], ['Square', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['9:16', 9 / 16]];
// The biggest rectangle of this shape, centered.
function fitAspect(W, H, ar) {
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: Math.round(w), h: Math.round(h) };
}
function cropGroup({ size, getCrop, setCrop, onLive, live }) {
  const g = group('Crop', '<button class="link" data-reset>Reset</button>');
  const toggle = button(`${icon('crop')}<span>Crop</span>`, () => onLive(!live()));
  const row = el('div', 'row');
  const aspects = ASPECTS.map(([name, ar]) => {
    const b = button(name, () => {
      const { w: W, h: H } = size();
      g.dataset.ar = name;
      aspects.forEach((x) => x.classList.toggle('on', x === b));
      if (ar === 0) { if (!live()) onLive(true); return; }
      setCrop(fitAspect(W, H, ar === -1 ? W / H : ar));
      if (!live()) onLive(true);
    }, 'tbtn sm');
    if (name === 'Free') b.classList.add('on');
    return b;
  });
  g.dataset.ar = 'Free';
  row.append(...aspects);
  g.append(toggle, row);
  g.querySelector('[data-reset]').addEventListener('click', () => setCrop(null));
  return {
    ratio: () => { const a = ASPECTS.find(([n]) => n === g.dataset.ar)?.[1] || 0; const { w, h } = size(); return a === -1 ? w / h : a; },
    sync: () => { toggle.classList.toggle('on', live()); toggle.querySelector('span').textContent = live() ? 'Done cropping' : 'Crop'; },
  };
}

// ============ the Compress card (every kind of file) ============
// A slider for how hard to squeeze, and what that comes to: about how big the file will be, how much of the
// original that saves, and a bar of the new size against the old. `estimate()` is run a moment after each
// change (the newest one wins) and answers with a size in bytes, or null when it can't tell.
function compressCard({ title = 'Compress', estimate, orig = () => F.size }) {
  const g = group(title, '<span class="pct" id="cpct"></span>');
  g.classList.add('compress');
  const host = el('div', 'cslider');
  const est = el('div', 'est', '<b id="cest">…</b><span id="cwas"></span>');
  const meter = el('div', 'meter', '<i id="cnew"></i>');
  const note = el('p', 'note', '');
  g.append(host, est, meter, note);
  let gen = 0, timer = 0, s = null;
  const run = async () => {
    const my = ++gen;
    g.classList.add('busy');
    $('cest').textContent = 'Working it out…';
    let size = null;
    try { size = await estimate(); } catch { size = null; }
    if (my !== gen || !g.isConnected) return;
    g.classList.remove('busy');
    show(size);
  };
  function show(size) {
    const was = orig();
    $('cwas').textContent = was ? `now ${fmtSize(was)}` : '';
    if (size == null) { $('cest').textContent = 'Can’t tell yet'; $('cpct').textContent = ''; $('cnew').style.width = '0'; return; }
    $('cest').textContent = `≈ ${fmtSize(Math.max(0, Math.round(size)))}`;
    const pct = was ? Math.round((1 - size / was) * 100) : 0;
    const p = $('cpct');
    p.textContent = !was ? '' : pct > 0 ? `saves ${pct}%` : pct < 0 ? `${-pct}% bigger` : 'same size';
    p.classList.toggle('worse', pct < 0);
    $('cnew').style.width = `${was ? clamp((size / was) * 100, 2, 100) : 0}%`;
    meter.classList.toggle('worse', pct < 0);
  }
  return {
    g,
    // Swap in the slider for what's being saved (quality, colors, a ZIP's level…).
    slider(cfg) {
      const key = JSON.stringify([cfg.label, cfg.min, cfg.max, cfg.step]);
      if (s?.key !== key) { host.innerHTML = ''; s = { key, ...slider(host, cfg) }; } else s.set(cfg.value);
      host.hidden = false;
    },
    hideSlider() { host.hidden = true; },
    note(text) { note.textContent = text || ''; note.hidden = !text; },
    soon(ms = 260) { clearTimeout(timer); gen++; timer = setTimeout(run, ms); },
    now: run,
  };
}

// ============ pictures ============
const PEN_COLORS = [['#1B1D3A', 'Black'], ['#FFFFFF', 'White'], ['#FF3B30', 'Red'], ['#FFCC00', 'Yellow'], ['#34C759', 'Green'], ['#0A84FF', 'Blue']];
const PEN_SIZES = [2, 5, 12]; // on screen, in points
const ERASER_SIZES = [8, 20, 44];
const LOSSY = ['jpg', 'webp', 'heic', 'avif'];
// Which types keep every frame: an animation's (gif, png), an icon's sizes (icns, ico), or either as pages.
const MULTI = { gif: 'anim', png: 'anim', tiff: 'any', icns: 'set', ico: 'set', pdf: 'any' };
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
// The Colors slider: 100 keeps them all; below that, 256 colors down to 2.
const colorsAt = (v) => (v >= 100 ? 0 : Math.max(2, Math.round(Math.pow(256, v / 99))));

// Fewer colors, for a smaller PNG or GIF: median cut over a sample of the pixels, then every pixel takes the
// nearest of them (looked up once per 15-bit color, so even a big picture is quick).
function quantize(src, n) {
  const w = src.width, h = src.height;
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  const total = w * h, step = Math.max(1, Math.floor(total / 50000));
  const pts = [];
  for (let p = 0; p < total; p += step) { const o = p * 4; if (d[o + 3] >= 8) pts.push([d[o], d[o + 1], d[o + 2]]); }
  if (!pts.length) return c;
  const range = (b) => { let best = -1, ch = 0; for (let k = 0; k < 3; k++) { let lo = 255, hi = 0; for (const p of b) { if (p[k] < lo) lo = p[k]; if (p[k] > hi) hi = p[k]; } if (hi - lo > best) { best = hi - lo; ch = k; } } return { r: best, ch }; };
  let boxes = [{ pts, ...range(pts) }];
  while (boxes.length < n) {
    let bi = -1, score = 0;
    boxes.forEach((b, i) => { const sc = b.r * Math.sqrt(b.pts.length); if (b.pts.length > 1 && b.r > 0 && sc > score) { score = sc; bi = i; } });
    if (bi < 0) break;
    const b = boxes[bi];
    b.pts.sort((p, q) => p[b.ch] - q[b.ch]);
    const mid = b.pts.length >> 1, lo = b.pts.slice(0, mid), hi = b.pts.slice(mid);
    boxes.splice(bi, 1, { pts: lo, ...range(lo) }, { pts: hi, ...range(hi) });
  }
  const pal = boxes.map((b) => { let r = 0, g = 0, bl = 0; for (const p of b.pts) { r += p[0]; g += p[1]; bl += p[2]; } const k = b.pts.length; return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)]; });
  const cache = new Int16Array(32768).fill(-1);
  for (let o = 0; o < d.length; o += 4) {
    if (d[o + 3] === 0) continue;
    const key = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
    let pi = cache[key];
    if (pi < 0) {
      const r = ((key >> 10) << 3) + 4, g = (((key >> 5) & 31) << 3) + 4, b = ((key & 31) << 3) + 4;
      let best = Infinity;
      for (let i = 0; i < pal.length; i++) { const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b, e = dr * dr * 3 + dg * dg * 4 + db * db * 2; if (e < best) { best = e; pi = i; } }
      cache[key] = pi;
    }
    d[o] = pal[pi][0]; d[o + 1] = pal[pi][1]; d[o + 2] = pal[pi][2];
    if (d[o + 3] < 255) d[o + 3] = d[o + 3] > 240 ? 255 : Math.round(d[o + 3] / 17) * 17;
  }
  x.putImageData(img, 0, 0);
  return c;
}

// One mark on a frame's layer: pencil, eraser, a cleared box or a moved one. Everything is in the picture's own
// pixels (the biggest frame's); `s` scales it to a smaller frame (an icon's 16-pixel size, say).
function drawMark(ctx, m, s) {
  ctx.save();
  if (m.t === 'pen' || m.t === 'erase') {
    ctx.globalCompositeOperation = m.t === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = m.c || '#000';
    ctx.lineWidth = Math.max(0.5, m.w * s);
    ctx.lineCap = ctx.lineJoin = 'round';
    const p = m.p;
    if (p.length <= 2) { ctx.beginPath(); ctx.arc(p[0] * s, p[1] * s, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
    else {
      ctx.beginPath(); ctx.moveTo(p[0] * s, p[1] * s);
      for (let i = 2; i < p.length - 2; i += 2) { const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2; ctx.quadraticCurveTo(p[i] * s, p[i + 1] * s, mx * s, my * s); }
      ctx.lineTo(p.at(-2) * s, p.at(-1) * s);
      ctx.stroke();
    }
  } else if (m.t === 'clear') {
    ctx.clearRect(m.r.x * s, m.r.y * s, m.r.w * s, m.r.h * s);
  } else if (m.t === 'img') {
    // A pasted picture: `c` is its middle in the picture's own pixels, `w`/`h` its size as it shows, upright
    // in the view it was pasted into (o = that view's turn and flips), so it's drawn undoing them.
    const bmp = PASTES.get(m.id);
    if (bmp) {
      ctx.translate(m.c.x * s, m.c.y * s);
      ctx.rotate((-m.o.rot * Math.PI) / 180);
      ctx.scale(m.o.fh ? -1 : 1, m.o.fv ? -1 : 1);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, (-m.w * s) / 2, (-m.h * s) / 2, m.w * s, m.h * s);
    }
  } else if (m.t === 'move') {
    const { x, y, w, h } = m.r;
    const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    const tmp = new OffscreenCanvas(tw, th);
    tmp.getContext('2d').drawImage(ctx.canvas, x * s, y * s, w * s, h * s, 0, 0, tw, th);
    ctx.clearRect(x * s, y * s, w * s, h * s);
    ctx.drawImage(tmp, (x + m.dx) * s, (y + m.dy) * s, w * s, h * s);
  }
  ctx.restore();
}

// Pasted pictures, by id. Marks only carry the id, so undo (which keeps state as JSON) still works.
const PASTES = new Map();
let pasteSeq = 0;

const ImageKind = {
  async init() {
    if (F.frames?.length > 1) {
      this.frames = await Promise.all(F.frames.map(async (f) => ({ img: await createImageBitmap(new Blob([f.bytes], { type: 'image/png' })), w: f.w, h: f.h, delay: f.delay || 0, dpi: f.dpi || 72 })));
    } else {
      const img = new Image();
      img.src = F.image;
      await img.decode();
      this.frames = [{ img, w: img.naturalWidth, h: img.naturalHeight, delay: 0, dpi: 72 }];
    }
    let ref = 0;
    this.frames.forEach((f, i) => { if (f.w * f.h > this.frames[ref].w * this.frames[ref].h) ref = i; });
    this.W0 = this.frames[ref].w; this.H0 = this.frames[ref].h;
    this.multi = this.frames.length > 1;
    this.sizes = this.multi && this.frames.some((f) => f.w !== this.W0 || f.h !== this.H0); // an icon's sizes, not an animation
    this.fi = 0;
    this.layers = this.frames.map(() => null);
    this.shown = new Map(); this.sig = '';
    this.tool = 'select'; this.color = PEN_COLORS[2][0]; this.penSize = 1; this.eraseSize = 1; this.every = false;
    this.zoom = null; // null fits it to the window; otherwise screen points per pixel of what's shown
    this.sel = null; // a picked box, in the turned picture's pixels
    this.selPaste = null; // or the pasted picture that box is around (its id)
    this.playing = 0;
    state = { rot: 0, fh: false, fv: false, crop: null, out: null, adj: { b: 100, c: 100, s: 100, blur: 0, bw: false }, q: 0.9, colors: 100, marks: [] };
    stage.innerHTML = `<div class="imgstage${this.multi ? ' multi' : ''}">${this.multi ? '<div class="frames" id="frames"></div>' : ''}
      <div class="viewport" id="viewport"><div class="canvas-wrap" id="wrap"><div class="frame checker enter" id="frame"><canvas id="view"></canvas>
      <div class="sel" id="sel" hidden>${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i class="${h.length === 2 ? 'sh' : 'se'}" data-h="${h}"></i>`).join('')}<div class="selbar" id="selbar"></div></div></div></div>
      <div class="mtools" id="mtools"></div><div class="zoom" id="zoom"></div></div></div>`;
    this.view = $('view');
    this.crop = cropBox($('frame'), {
      size: () => this.dims(),
      get: () => state.crop,
      set: (r) => { state.crop = r; state.out = null; this.syncResize(); },
      begin: () => { this.before = JSON.stringify(state); },
      end: () => { if (this.before !== JSON.stringify(state)) { hist.past.push(this.before); hist.future = []; changed(); } },
      ratio: () => this.cropUI.ratio(),
    });
    this.tools();
    this.toolbar();
    this.zoomBar();
    if (this.multi) this.strip();
    this.pointer();
    new ResizeObserver(() => this.draw()).observe($('wrap'));
    this.apply();
  },
  dims() { return state.rot % 180 ? { w: this.H0, h: this.W0 } : { w: this.W0, h: this.H0 }; },
  cropRect() { const { w, h } = this.dims(); return state.crop || { x: 0, y: 0, w, h }; },
  outSize() { const r = this.cropRect(); return this.sizes ? { w: r.w, h: r.h } : state.out || { w: r.w, h: r.h }; },
  filter(k = 1) {
    const a = state.adj;
    return `brightness(${a.b}%) contrast(${a.c}%) saturate(${a.s}%)${a.bw ? ' grayscale(1)' : ''}${a.blur ? ` blur(${(a.blur * k).toFixed(2)}px)` : ''}`;
  },
  // A frame with its marks drawn in. Kept between draws; a new mark is drawn onto it, an undo starts it over.
  layer(i) {
    const f = this.frames[i];
    const marks = state.marks.filter((m) => m.f === -1 || m.f === i);
    if (!marks.length) { this.layers[i] = null; return f.img; }
    let L = this.layers[i];
    if (!L || L.list.length > marks.length || L.list.some((m, j) => m !== marks[j])) {
      L = { c: new OffscreenCanvas(f.w, f.h), list: [] };
      L.c.getContext('2d').drawImage(f.img, 0, 0);
      this.layers[i] = L;
    }
    const x = L.c.getContext('2d'), s = f.w / this.W0;
    for (let j = L.list.length; j < marks.length; j++) drawMark(x, marks[j], s);
    L.list = marks;
    return L.c;
  },
  // The whole (turned, flipped) picture on a canvas, `k` canvas px per picture px.
  paint(ctx, k, i = this.fi) {
    const { w, h } = this.dims();
    ctx.save();
    ctx.translate((w * k) / 2, (h * k) / 2);
    ctx.scale(state.fh ? -1 : 1, state.fv ? -1 : 1);
    ctx.rotate((state.rot * Math.PI) / 180);
    ctx.drawImage(this.layer(i), (-this.W0 * k) / 2, (-this.H0 * k) / 2, this.W0 * k, this.H0 * k);
    ctx.restore();
  },
  // What saving writes for frame i, at its own size: turned, adjusted, marked, cropped (to `r`) and sized.
  render(i, part = null) {
    const r = part || this.cropRect(), o = part ? { w: part.w, h: part.h } : this.outSize();
    const s = this.frames[i].w / this.W0;
    const { w, h } = this.dims();
    const full = new OffscreenCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    const fx = full.getContext('2d');
    fx.filter = this.filter(s);
    this.paint(fx, s, i);
    const ow = Math.max(1, Math.round(o.w * s)), oh = Math.max(1, Math.round(o.h * s));
    const out = new OffscreenCanvas(ow, oh);
    const ox = out.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(full, r.x * s, r.y * s, r.w * s, r.h * s, 0, 0, ow, oh);
    return out;
  },
  colorsFor(ext) { return LOSSY.includes(ext) || ext === 'bmp' ? 0 : colorsAt(state.colors); },
  keeps(ext) { const m = MULTI[ext]; return this.multi && !!m && (m === 'any' || (m === 'anim' ? !this.sizes : this.sizes)); },
  // Which frames a save of this type writes: all of them, or the one you're looking at.
  frameList(ext) {
    if (!this.keeps(ext)) return [this.fi];
    let list = this.frames.map((_, i) => i);
    if (ext === 'ico') { const seen = new Set(); list = list.filter((i) => { const f = this.frames[i]; if (f.w > 256 || seen.has(f.w)) return false; seen.add(f.w); return true; }); }
    return list.length ? list : [this.fi];
  },

  // ---------- showing it ----------
  // The stage shows the result: just the cropped part, at the size it will be saved, fitted to the window (so
  // a picture scaled up or down fills the space again, and its pixels show at their real sharpness). While
  // cropping it shows the whole picture instead, with the crop box over it.
  content() { return this.crop.isLive() ? this.dims() : this.outSize(); },
  fit() {
    const wrap = $('wrap'), c = this.content();
    return Math.max(0.01, Math.min((wrap.clientWidth - 68) / c.w, (wrap.clientHeight - 80) / c.h));
  },
  maxZoom() { const c = this.content(); return Math.max(this.fit(), Math.min(48, 12000 / (Math.max(c.w, c.h) * DPR()))); },
  draw() {
    const wrap = $('wrap');
    if (!wrap || !state || K !== this) return;
    const live = this.crop.isLive(), c = this.content(), dpr = DPR();
    const z = this.zoom == null ? this.fit() : clamp(this.zoom, 0.02, this.maxZoom());
    this.z = z;
    const cw = Math.max(1, Math.round(c.w * z)), ch = Math.max(1, Math.round(c.h * z));
    const v = this.view;
    if (v.width !== cw * dpr || v.height !== ch * dpr) { v.width = cw * dpr; v.height = ch * dpr; }
    v.style.width = `${cw}px`; v.style.height = `${ch}px`;
    const ctx = v.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    if (live) {
      ctx.filter = this.filter(z * dpr);
      this.paint(ctx, z * dpr);
      ctx.filter = 'none';
    } else {
      const res = this.result(this.fi, cw * dpr, ch * dpr);
      ctx.imageSmoothingEnabled = v.width / res.width < 3.5; // close up, the pixels show as squares, as they are
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(res, 0, 0, v.width, v.height);
    }
    this.crop.place(z);
    if (!live) this.crop.el.hidden = true;
    this.placeSel();
    this.zoomUI?.();
  },
  // What the stage draws for frame i, kept until something changes. Bigger than the screen: painted straight
  // at the screen's size (quick, even while a slider moves). Smaller: made at its real size and blown up.
  result(i, dw, dh) {
    if (state.marks !== this.lastMarks) { this.lastMarks = state.marks; this.mver = (this.mver || 0) + 1; }
    const sig = JSON.stringify([state.rot, state.fh, state.fv, state.crop, state.out, state.adj, this.mver, this.colorsFor(fmt())]);
    if (sig !== this.sig) { this.sig = sig; this.shown.clear(); }
    const o = this.outSize(), s = this.frames[i].w / this.W0;
    const small = o.w * s <= dw * 1.02;
    const key = `${i}|${small ? 'real' : `${dw}x${dh}`}`;
    let c = this.shown.get(key);
    if (!c) {
      if (small) c = this.render(i);
      else {
        const r = this.cropRect(), g = dw / r.w;
        c = new OffscreenCanvas(dw, dh);
        const x = c.getContext('2d');
        x.translate(-r.x * g, -r.y * g);
        x.filter = this.filter(g);
        this.paint(x, g, i);
      }
      const n = this.colorsFor(fmt());
      if (n) c = quantize(c, n); // the fewer colors show, so you see what the slider does
      if (this.shown.size > 80) this.shown.clear();
      this.shown.set(key, c);
    }
    return c;
  },
  apply() {
    if (this.selPaste) { // after an undo the pasted picture may have moved, or be gone
      const m = state.marks.find((q) => q.t === 'img' && q.id === this.selPaste);
      if (m) this.sel = this.roundBox(this.pasteBox(m)); else { this.sel = null; this.selPaste = null; }
    }
    this.draw(); this.syncResize(); this.cropUI.sync(); this.adjUI?.();
    this.rs.hidden = this.sizes;
    this.syncStrip(); this.syncTools();
    if (this.ccExt !== fmt() + state.q + state.colors) { this.ccExt = fmt() + state.q + state.colors; this.onFormat(fmt()); }
  },

  // ---------- zoom ----------
  zoomBar() {
    const z = $('zoom');
    z.innerHTML = `<button data-z="out" title="Zoom out (⌘−)">−</button><button data-z="fit" class="zl" id="zlabel" title="Fit to the window, or actual size (⌘9)"></button><button data-z="in" title="Zoom in (⌘+)">+</button>`;
    z.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return; b.blur();
      if (b.dataset.z === 'in') this.zoomStep(1);
      else if (b.dataset.z === 'out') this.zoomStep(-1);
      else this.setZoom(this.zoom == null ? 1 : null);
    });
    this.zoomUI = () => { $('zlabel').textContent = `${this.zoom == null ? 'Fit · ' : ''}${Math.round(((this.z * this.W0) / this.frames[this.fi].w) * 100)}%`; }; // of the frame on show (an icon's 16-pixel size is far bigger)
    $('wrap').addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // a pinch on the trackpad comes as a wheel with ctrl held
      e.preventDefault();
      this.setZoom(this.z * Math.exp(-e.deltaY * 0.01), e);
    }, { passive: false });
  },
  zoomStep(dir) {
    const z = this.z;
    const next = dir > 0 ? ZOOMS.find((v) => v > z * 1.01) : [...ZOOMS].reverse().find((v) => v < z * 0.99);
    this.setZoom(next ?? z);
  },
  // Zoom, keeping the spot under the pointer (or the middle) where it is.
  setZoom(z, at = null) {
    const wrap = $('wrap'), v = this.view;
    const before = v.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const px = at ? at.clientX : wr.left + wr.width / 2, py = at ? at.clientY : wr.top + wr.height / 2;
    const fx = (px - before.left) / before.width, fy = (py - before.top) / before.height;
    this.zoom = z == null ? null : clamp(z, 0.02, this.maxZoom());
    if (this.zoom != null && Math.abs(this.zoom - this.fit()) < 0.002) this.zoom = null;
    this.draw();
    const after = v.getBoundingClientRect();
    wrap.scrollLeft += after.left + fx * after.width - px;
    wrap.scrollTop += after.top + fy * after.height - py;
  },

  // ---------- frames: an animation's, an icon's sizes, a document's pages ----------
  strip() {
    const s = $('frames');
    const what = this.sizes ? 'size' : this.frames.some((f) => f.delay > 0) ? 'frame' : 'page';
    this.what = what;
    s.innerHTML = `<div class="fhead"><b>${this.frames.length}${F.partialFrames ? '+' : ''} ${what}s</b>${what === 'frame' ? `<button class="fplay" id="fplay" title="Play">${icon('play')}</button>` : ''}</div><div class="flist" id="flist"></div>`;
    const list = $('flist');
    this.frames.forEach((f, i) => {
      const b = el('button', 'fr');
      const c = document.createElement('canvas');
      const k = Math.min(1, 96 / Math.max(f.w, f.h));
      c.width = Math.max(1, Math.round(f.w * k)); c.height = Math.max(1, Math.round(f.h * k));
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = k < 1;
      cx.drawImage(f.img, 0, 0, c.width, c.height);
      b.append(c, el('span', 'fn', this.sizes ? `${f.w} × ${f.h}${f.dpi > 100 ? ' @2x' : ''}` : `${i + 1}${f.delay ? ` · ${+f.delay.toFixed(2)} s` : ''}`));
      b.addEventListener('click', () => { this.stop(); this.show(i); });
      list.append(b);
    });
    $('fplay')?.addEventListener('click', (e) => { e.currentTarget.blur(); this.playing ? this.stop() : this.play(); });
  },
  show(i) {
    this.fi = clamp(i, 0, this.frames.length - 1);
    this.sel = null;
    this.draw(); this.syncStrip(); changed();
  },
  syncStrip() {
    const list = $('flist');
    if (!list) return;
    [...list.children].forEach((b, i) => b.classList.toggle('on', i === this.fi));
    list.children[this.fi]?.scrollIntoView({ block: 'nearest' });
  },
  play() {
    this.playing = 1;
    $('fplay').innerHTML = icon('pause');
    const tick = () => {
      if (!this.playing || K !== this) return;
      this.fi = (this.fi + 1) % this.frames.length;
      this.draw(); this.syncStrip();
      this.playing = setTimeout(tick, Math.max(20, (this.frames[this.fi].delay || 0.1) * 1000));
    };
    this.playing = setTimeout(tick, Math.max(20, (this.frames[this.fi].delay || 0.1) * 1000));
  },
  stop() { if (!this.playing) return; clearTimeout(this.playing); this.playing = 0; if ($('fplay')) $('fplay').innerHTML = icon('play'); changed(); },

  // ---------- pencil, eraser, picking a box ----------
  toolbar() {
    const t = $('mtools');
    const tools = [['select', 'Select a part (drag)', '<rect x="4" y="5" width="16" height="14" rx="1.5" stroke-dasharray="3 2.6"/>'],
      ['pen', 'Pencil', '<path d="M4 20l1.2-4.6L16 4.6a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M14 6.6l3.4 3.4"/>'],
      ['erase', 'Eraser', '<path d="M8.5 19.5 3.8 14.8a2 2 0 0 1 0-2.8l8-8a2 2 0 0 1 2.8 0l5.4 5.4a2 2 0 0 1 0 2.8l-7.7 7.3z"/><path d="M8 9.5l6.5 6.5M8.5 19.5H20"/>']];
    t.innerHTML = `<div class="tgroup">${tools.map(([k, n, p]) => `<button data-tool="${k}" title="${n}" aria-label="${n}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg></button>`).join('')}</div>
      <div class="tgroup colors" id="tcolors">${PEN_COLORS.map(([c, n]) => `<button data-color="${c}" title="${n}" aria-label="${n}"><i style="background:${c}"></i></button>`).join('')}</div>
      <div class="tgroup sizes" id="tsizes">${[0, 1, 2].map((i) => `<button data-size="${i}" title="${['Thin', 'Medium', 'Thick'][i]}"><i style="--d:${[4, 8, 13][i]}px"></i></button>`).join('')}</div>
      ${this.multi ? `<button class="tevery" id="tevery" title="Draw and erase on every ${this.sizes ? 'size' : 'frame'}, not just this one">All ${this.sizes ? 'sizes' : 'frames'}</button>` : ''}`;
    t.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return; b.blur();
      if (b.dataset.tool) { this.tool = b.dataset.tool; if (this.tool !== 'select') { this.sel = null; this.placeSel(); } }
      if (b.dataset.color) { this.color = b.dataset.color; if (this.tool !== 'pen') this.tool = 'pen'; }
      if (b.dataset.size) this[this.tool === 'erase' ? 'eraseSize' : 'penSize'] = +b.dataset.size;
      if (b.id === 'tevery') this.every = !this.every;
      this.syncTools();
    });
    this.syncTools();
  },
  syncTools() {
    const t = $('mtools'); if (!t) return;
    const live = this.crop.isLive();
    t.classList.toggle('off', live);
    t.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === this.tool));
    t.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === this.color));
    const sz = this.tool === 'erase' ? this.eraseSize : this.penSize;
    t.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', +b.dataset.size === sz));
    $('tcolors').hidden = this.tool !== 'pen';
    $('tsizes').hidden = this.tool === 'select';
    $('tevery')?.classList.toggle('on', this.every);
    if ($('tevery')) $('tevery').hidden = this.tool === 'select' && !this.sel;
    $('wrap').dataset.tool = live ? 'crop' : this.tool;
  },
  // Screen points on the stage to the turned picture's pixels, and those to the picture's own pixels.
  toDims(e) {
    const b = this.view.getBoundingClientRect(), r = this.cropRect(), o = this.outSize();
    const k = this.z * (o.w / r.w); // screen points per picture pixel
    return { x: r.x + (e.clientX - b.left) / k, y: r.y + (e.clientY - b.top) / k, k };
  },
  toImage(x, y) {
    const { w, h } = this.dims();
    let u = x - w / 2, v = y - h / 2;
    if (state.fh) u = -u;
    if (state.fv) v = -v;
    const a = (-state.rot * Math.PI) / 180, cs = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a));
    return { x: u * cs - v * sn + this.W0 / 2, y: u * sn + v * cs + this.H0 / 2 };
  },
  // The other way: the picture's own pixels to the turned picture's.
  fromImage(x, y) {
    const { w, h } = this.dims();
    const a = (state.rot * Math.PI) / 180, cs = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a));
    const u = x - this.W0 / 2, v = y - this.H0 / 2;
    let px = u * cs - v * sn, py = u * sn + v * cs;
    if (state.fh) px = -px;
    if (state.fv) py = -py;
    return { x: px + w / 2, y: py + h / 2 };
  },
  // ---------- pasted pictures ----------
  pasteMarks() { return state.marks.filter((m) => m.t === 'img' && (m.f === -1 || m.f === this.fi)); },
  // Where a pasted picture shows now, as a box in the turned picture's pixels (it turns with the picture).
  pasteBox(m) {
    const c = this.fromImage(m.c.x, m.c.y);
    const turned = ((state.rot - m.o.rot + 360) % 180) !== 0;
    const w = turned ? m.h : m.w, h = turned ? m.w : m.h;
    return { x: c.x - w / 2, y: c.y - h / 2, w, h };
  },
  pasteAt(p) {
    const list = this.pasteMarks();
    for (let i = list.length - 1; i >= 0; i--) { const b = this.pasteBox(list[i]); if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return list[i]; }
    return null;
  },
  // Put the picked box's place and size back onto the pasted picture it's around.
  boxToPaste(m, b) {
    const turned = ((state.rot - m.o.rot + 360) % 180) !== 0;
    return { ...m, c: this.toImage(b.x + b.w / 2, b.y + b.h / 2), w: turned ? b.h : b.w, h: turned ? b.w : b.h };
  },
  selectPaste(m) { this.tool = 'select'; this.selPaste = m.id; this.sel = this.roundBox(this.pasteBox(m)); this.placeSel(); },
  roundBox(b) { return { x: Math.round(b.x), y: Math.round(b.y), w: Math.max(1, Math.round(b.w)), h: Math.max(1, Math.round(b.h)) }; },
  async paste() {
    if (this.crop.isLive()) return;
    const bytes = await scrawl.invoke('tweak:pasteImage');
    if (!bytes) { toast('There’s no picture on the clipboard to paste.', null, true); return; }
    let bmp;
    try { bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); } catch { toast('Couldn’t paste that picture.', null, true); return; }
    const id = `p${Date.now().toString(36)}${pasteSeq++}`;
    PASTES.set(id, bmp);
    // It lands in the middle of what you can see, at its own size, or smaller if it wouldn't fit.
    const r = this.cropRect(), wrap = $('wrap'), wb = wrap.getBoundingClientRect(), vb = this.view.getBoundingClientRect();
    const k = this.toDims({ clientX: 0, clientY: 0 }).k;
    const vis = {
      x0: Math.max(r.x, r.x + (wb.left - vb.left) / k), y0: Math.max(r.y, r.y + (wb.top - vb.top) / k),
      x1: Math.min(r.x + r.w, r.x + (wb.right - vb.left) / k), y1: Math.min(r.y + r.h, r.y + (wb.bottom - vb.top) / k),
    };
    if (vis.x1 <= vis.x0 || vis.y1 <= vis.y0) Object.assign(vis, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
    const g = Math.min(1, ((vis.x1 - vis.x0) * 0.8) / bmp.width, ((vis.y1 - vis.y0) * 0.8) / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * g)), h = Math.max(1, Math.round(bmp.height * g));
    const c = this.toImage((vis.x0 + vis.x1) / 2, (vis.y0 + vis.y1) / 2);
    const m = { t: 'img', id, c, w, h, o: { rot: state.rot, fh: state.fh, fv: state.fv }, f: this.multi && !this.every ? this.fi : -1 };
    commit({ ...state, marks: [...state.marks, m] });
    this.selectPaste(m);
    toast('Pasted. Drag it to move it, or a corner to size it.');
  },
  removePaste(id) { commit({ ...state, marks: state.marks.filter((m) => !(m.t === 'img' && m.id === id)) }); this.sel = null; this.selPaste = null; this.placeSel(); },
  rectToImage(r) {
    const a = this.toImage(r.x, r.y), b = this.toImage(r.x + r.w, r.y + r.h);
    return { x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), w: Math.round(Math.abs(b.x - a.x)), h: Math.round(Math.abs(b.y - a.y)) };
  },
  addMark(m) { commit({ ...state, marks: [...state.marks, { ...m, f: this.multi && !this.every ? this.fi : -1 }] }); },
  pointer() {
    const v = this.view;
    v.addEventListener('pointerdown', (e) => {
      if (this.crop.isLive() || e.button !== 0) return;
      e.preventDefault();
      this.stop();
      v.setPointerCapture(e.pointerId);
      if (this.tool === 'select') {
        const hit = this.pasteAt(this.toDims(e));
        if (hit) { this.selectPaste(hit); this.adjustDrag(e); return; }
        this.selectDrag(e);
      } else this.strokeDrag(e);
    });
    $('sel').addEventListener('pointerdown', (e) => {
      if (e.target.closest('.selbar') || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.adjustDrag(e);
    });
  },
  strokeDrag(e) {
    const v = this.view, ctx = v.getContext('2d'), dpr = DPR(), b = v.getBoundingClientRect();
    const erase = this.tool === 'erase';
    const pts = (erase ? ERASER_SIZES[this.eraseSize] : PEN_SIZES[this.penSize]);
    const start = this.toDims(e);
    const img = [];
    const push = (ev) => { const d = this.toDims(ev), p = this.toImage(d.x, d.y); img.push(Math.round(p.x * 2) / 2, Math.round(p.y * 2) / 2); };
    push(e);
    // While drawing, the line goes straight onto the screen; it joins the picture when you let go.
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = this.color;
    ctx.lineWidth = pts; ctx.lineCap = ctx.lineJoin = 'round';
    let lx = e.clientX - b.left, ly = e.clientY - b.top;
    ctx.beginPath(); ctx.arc(lx, ly, pts / 2, 0, Math.PI * 2); ctx.fill();
    const move = (ev) => {
      const x = ev.clientX - b.left, y = ev.clientY - b.top;
      if (Math.hypot(x - lx, y - ly) < 1.2) return;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke();
      lx = x; ly = y;
      push(ev);
    };
    const up = () => {
      v.removeEventListener('pointermove', move);
      ctx.restore();
      this.addMark({ t: erase ? 'erase' : 'pen', c: erase ? undefined : this.color, w: Math.round((pts / start.k) * 100) / 100, p: img });
    };
    v.addEventListener('pointermove', move);
    v.addEventListener('pointerup', up, { once: true });
    v.addEventListener('pointercancel', up, { once: true });
  },
  selectDrag(e) {
    const v = this.view, a = this.toDims(e), r = this.cropRect();
    const move = (ev) => {
      const b = this.toDims(ev);
      const x0 = clamp(Math.min(a.x, b.x), r.x, r.x + r.w), y0 = clamp(Math.min(a.y, b.y), r.y, r.y + r.h);
      const x1 = clamp(Math.max(a.x, b.x), r.x, r.x + r.w), y1 = clamp(Math.max(a.y, b.y), r.y, r.y + r.h);
      this.sel = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      this.placeSel(true);
    };
    const up = () => {
      v.removeEventListener('pointermove', move);
      if (this.sel && (this.sel.w < 2 || this.sel.h < 2)) this.sel = null;
      this.placeSel();
    };
    this.sel = null; this.selPaste = null; this.placeSel();
    v.addEventListener('pointermove', move);
    v.addEventListener('pointerup', up, { once: true });
  },
  // The picked box is only a frame, as in Preview: drag inside it to move it, or a corner or side to resize
  // it. The picture under it stays where it is.
  adjustDrag(e) {
    const s = $('sel'), h = e.target.dataset?.h || 'move';
    const s0 = { ...this.sel }, a = this.toDims(e), r = this.cropRect();
    s.setPointerCapture(e.pointerId);
    const pid = this.selPaste, pm = pid && state.marks.find((m) => m.t === 'img' && m.id === pid);
    if (pm) return this.pasteDrag(e, s, h, pm, a);
    const move = (ev) => {
      const b = this.toDims(ev), dx = b.x - a.x, dy = b.y - a.y;
      let x0 = s0.x, y0 = s0.y, x1 = s0.x + s0.w, y1 = s0.y + s0.h;
      if (h === 'move') {
        const nx = clamp(s0.x + dx, r.x, r.x + r.w - s0.w), ny = clamp(s0.y + dy, r.y, r.y + r.h - s0.h);
        x0 = nx; y0 = ny; x1 = nx + s0.w; y1 = ny + s0.h;
      } else {
        if (h.includes('w')) x0 = clamp(s0.x + dx, r.x, x1 - 2);
        if (h.includes('e')) x1 = clamp(x1 + dx, x0 + 2, r.x + r.w);
        if (h.includes('n')) y0 = clamp(s0.y + dy, r.y, y1 - 2);
        if (h.includes('s')) y1 = clamp(y1 + dy, y0 + 2, r.y + r.h);
      }
      this.sel = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      this.placeSel(true);
    };
    const up = () => { s.removeEventListener('pointermove', move); this.placeSel(); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up, { once: true });
    s.addEventListener('pointercancel', up, { once: true });
  },
  // A pasted picture moves anywhere (even partly off the edge), and a corner sizes it, keeping its shape
  // (⇧ frees it); a side stretches it. It lands as one undo step when you let go.
  pasteDrag(e, s, h, pm, a) {
    const before = JSON.stringify(state), b0 = this.pasteBox(pm), ratio = b0.w / b0.h;
    let moved = false;
    const move = (ev) => {
      const b = this.toDims(ev), dx = b.x - a.x, dy = b.y - a.y;
      if (!moved && Math.hypot(dx * b.k, dy * b.k) < 2) return;
      moved = true;
      let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
      if (h === 'move') { x0 += dx; x1 += dx; y0 += dy; y1 += dy; }
      else {
        if (h.includes('w')) x0 = Math.min(b0.x + dx, x1 - 4);
        if (h.includes('e')) x1 = Math.max(x1 + dx, x0 + 4);
        if (h.includes('n')) y0 = Math.min(b0.y + dy, y1 - 4);
        if (h.includes('s')) y1 = Math.max(y1 + dy, y0 + 4);
        if (h.length === 2 && !ev.shiftKey) { // a corner: keep its shape, pinned at the opposite corner
          let w = x1 - x0, ht = y1 - y0;
          if (w / ht > ratio) ht = w / ratio; else w = ht * ratio;
          if (h.includes('w')) x0 = x1 - w; else x1 = x0 + w;
          if (h.includes('n')) y0 = y1 - ht; else y1 = y0 + ht;
        }
      }
      const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      state = { ...state, marks: state.marks.map((m) => (m.t === 'img' && m.id === pm.id ? this.boxToPaste(m, box) : m)) };
      this.sel = this.roundBox(box);
      this.draw();
      this.placeSel(true);
    };
    const up = () => {
      s.removeEventListener('pointermove', move);
      if (moved && before !== JSON.stringify(state)) { hist.past.push(before); hist.future = []; changed(); }
      this.placeSel();
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up, { once: true });
    s.addEventListener('pointercancel', up, { once: true });
  },
  placeSel(dragging = false) {
    const s = $('sel');
    if (!s) return;
    const c = this.sel;
    if (!c) this.selPaste = null;
    s.hidden = !c || this.crop.isLive();
    if (!c || s.hidden) { this.syncTools(); return; }
    const r = this.cropRect(), o = this.outSize(), k = this.z * (o.w / r.w);
    Object.assign(s.style, { left: `${(c.x - r.x) * k}px`, top: `${(c.y - r.y) * k}px`, width: `${c.w * k}px`, height: `${c.h * k}px` });
    const bar = $('selbar'), mode = this.selPaste ? 'paste' : 'sel';
    if (bar.dataset.mode !== mode) {
      bar.dataset.mode = mode;
      bar.replaceChildren(...(mode === 'paste'
        ? [button('Done', () => { this.sel = null; this.selPaste = null; this.placeSel(); }, 'sb'), button('Copy', () => this.copySel(), 'sb'), button('Cut', () => this.copySel(true), 'sb'), button('Delete', () => this.removePaste(this.selPaste), 'sb')]
        : [button('Crop to this', () => this.cropToSel(), 'sb'), button('Copy', () => this.copySel(), 'sb'), button('Cut', () => this.copySel(true), 'sb'), button('Clear', () => this.clearSel(), 'sb')]));
      if (!bar.dataset.wired) { bar.dataset.wired = 1; bar.addEventListener('pointerdown', (e) => e.stopPropagation()); }
    }
    bar.dataset.dims = `${c.w} × ${c.h}`;
    s.classList.toggle('dragging', dragging);
    // The bar sits below the box, clear of its handles. If that would run off the bottom of what you can
    // see, it goes above instead, and if neither has room, just inside the box's bottom edge.
    if (!dragging) {
      s.classList.remove('bar-up', 'bar-in');
      const wb = $('wrap').getBoundingClientRect(), sb = s.getBoundingClientRect(), bh = bar.offsetHeight + 18;
      if (sb.bottom + bh > wb.bottom - 4) s.classList.add(sb.top - bh >= wb.top + 54 ? 'bar-up' : 'bar-in'); // 54: the tools along the top
      // …and sideways it stays inside the stage, so a box by the edge doesn't push it out of sight.
      bar.style.marginLeft = '0px';
      const br = bar.getBoundingClientRect();
      bar.style.marginLeft = `${Math.max(0, wb.left + 8 - br.left) - Math.max(0, br.right - (wb.right - 8))}px`;
    }
    this.syncTools();
  },
  cropToSel() { const c = this.sel; if (!c) return; this.sel = null; this.zoom = null; commit({ ...state, crop: c, out: null }); },
  clearSel() { const c = this.sel; if (!c) return; if (this.selPaste) { this.removePaste(this.selPaste); return; } this.addMark({ t: 'clear', r: this.rectToImage(c) }); },
  async copySel(cut = false) {
    const c = this.sel; if (!c) return;
    let blob;
    const pm = this.selPaste && PASTES.get(this.selPaste);
    if (pm) { // a pasted picture copies as itself, at the size it shows, not what's behind it
      const oc = new OffscreenCanvas(c.w, c.h), x = oc.getContext('2d');
      const m = state.marks.find((q) => q.t === 'img' && q.id === this.selPaste);
      x.translate(c.w / 2, c.h / 2); x.scale(state.fh !== m.o.fh ? -1 : 1, state.fv !== m.o.fv ? -1 : 1); x.rotate(((state.rot - m.o.rot) * Math.PI) / 180);
      const turned = ((state.rot - m.o.rot + 360) % 180) !== 0, w = turned ? c.h : c.w, h = turned ? c.w : c.h;
      x.drawImage(pm, -w / 2, -h / 2, w, h);
      blob = await oc.convertToBlob({ type: 'image/png' });
    } else blob = await this.render(this.fi, c).convertToBlob({ type: 'image/png' });
    const ok = await scrawl.invoke('tweak:copyImage', await blob.arrayBuffer());
    if (!ok) { toast('Couldn’t copy that part.', null, true); return; }
    if (cut) this.clearSel();
    toast(cut ? 'Cut. It’s on the clipboard.' : 'Copied. Paste it anywhere.');
  },

  // ---------- the inspector ----------
  tools() {
    this.cropUI = cropGroup({
      size: () => this.dims(), live: () => this.crop.isLive(),
      getCrop: () => state.crop, setCrop: (r) => { this.zoom = null; commit({ ...state, crop: r, out: null }); },
      onLive: (on) => { this.crop.live(on); this.zoom = null; this.sel = null; this.cropUI.sync(); this.syncTools(); this.draw(); },
    });
    const turn = group('Turn and flip');
    const row = el('div', 'row fill');
    // Turning carries the crop and the picked box around with the picture. Marks stay put on the picture itself.
    const turnBy = (d) => {
      const { w: RW, h: RH } = this.dims();
      let c = state.crop;
      if (c) c = d > 0 ? { x: RH - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: RW - (c.x + c.w), w: c.h, h: c.w };
      const out = state.out ? { w: state.out.h, h: state.out.w } : null;
      this.sel = null; this.zoom = null;
      commit({ ...state, rot: (state.rot + d + 360) % 360, crop: c, out });
    };
    const flip = (axis) => {
      const { w: RW, h: RH } = this.dims();
      let c = state.crop;
      if (c) c = axis === 'h' ? { ...c, x: RW - (c.x + c.w) } : { ...c, y: RH - (c.y + c.h) };
      this.sel = null;
      commit({ ...state, [axis === 'h' ? 'fh' : 'fv']: !state[axis === 'h' ? 'fh' : 'fv'], crop: c });
    };
    row.append(button(icon('left'), () => turnBy(-90), 'tbtn'), button(icon('right'), () => turnBy(90), 'tbtn'),
      button(icon('flipH'), () => flip('h'), 'tbtn'), button(icon('flipV'), () => flip('v'), 'tbtn'));
    [...row.children].forEach((b, i) => b.title = ['Turn left', 'Turn right', 'Flip across', 'Flip upside down'][i]);
    turn.append(row);

    const rs = group('Size', '<button class="link" data-reset>Reset</button>');
    this.rs = rs;
    rs.insertAdjacentHTML('beforeend', `<div class="pair"><div class="field"><label for="rw">Width</label><input class="num" id="rw" type="number" min="1" max="20000"></div><button class="lock on" id="rlock" title="Keep the shape">${icon('lock')}</button><div class="field"><label for="rh">Height</label><input class="num" id="rh" type="number" min="1" max="20000"></div></div>`);
    const pct = el('div', 'row fill tight');
    // A new size fits the stage again, so the picture is shown big whatever size it's becoming.
    const resize = (out) => { this.zoom = null; this.sel = null; commit({ ...state, out }); };
    [25, 50, 75, 100, 200].forEach((p) => pct.append(button(`${p}%`, () => { const r = this.cropRect(); resize(p === 100 ? null : { w: Math.max(1, Math.round(r.w * p / 100)), h: Math.max(1, Math.round(r.h * p / 100)) }); }, 'tbtn sm')));
    rs.append(pct);
    const lock = $('rlock');
    lock.addEventListener('click', () => { lock.classList.toggle('on'); lock.innerHTML = icon(lock.classList.contains('on') ? 'lock' : 'unlock'); });
    const sizeFrom = (which) => {
      const r = this.cropRect(), cur = this.outSize();
      let w = Math.round(+$('rw').value) || cur.w, h = Math.round(+$('rh').value) || cur.h;
      if (lock.classList.contains('on')) { if (which === 'w') h = Math.max(1, Math.round(w * r.h / r.w)); else w = Math.max(1, Math.round(h * r.w / r.h)); }
      w = clamp(w, 1, 20000); h = clamp(h, 1, 20000);
      resize(w === r.w && h === r.h ? null : { w, h });
    };
    $('rw').addEventListener('change', () => sizeFrom('w'));
    $('rh').addEventListener('change', () => sizeFrom('h'));
    rs.querySelector('[data-reset]').addEventListener('click', () => resize(null));

    const ad = group('Adjust', '<button class="link" data-reset>Reset</button>');
    const live = (key) => (v) => { state = { ...state, adj: { ...state.adj, [key]: v } }; this.draw(); };
    let pre = null;
    const remember = () => { pre ??= JSON.stringify(state); };
    const done = () => { if (pre && pre !== JSON.stringify(state)) { hist.past.push(pre); hist.future = []; changed(); } pre = null; };
    const mk = (label, key, min, max, unit) => slider(ad, { label, min, max, value: state.adj[key], unit, onInput: (v) => { remember(); live(key)(v); }, onChange: done });
    const S = { b: mk('Brightness', 'b', 0, 200, '%'), c: mk('Contrast', 'c', 0, 200, '%'), s: mk('Saturation', 's', 0, 200, '%'), blur: mk('Blur', 'blur', 0, 30, ' px') };
    const bw = switchLine(ad, 'Black and white', false, (v) => commit({ ...state, adj: { ...state.adj, bw: v } }));
    ad.querySelector('[data-reset]').addEventListener('click', () => commit({ ...state, adj: { b: 100, c: 100, s: 100, blur: 0, bw: false } }));
    this.adjUI = () => { for (const k of Object.keys(S)) S[k].set(state.adj[k]); bw.set(state.adj.bw); };

    const mg = group('Draw', '<button class="link" data-reset>Clear all</button>');
    mg.append(el('p', 'note', 'Pick the pencil or eraser over the picture, or drag out a box: move it or pull its corners to fit, then crop, copy, cut or clear what’s in it. Delete clears it; ⌘C copies it.'));
    mg.querySelector('[data-reset]').addEventListener('click', () => { if (state.marks.length) commit({ ...state, marks: [] }); });

    this.cc = compressCard({ estimate: () => this.estimate() });
  },
  syncResize() {
    const o = this.outSize();
    if ($('rw')) { $('rw').value = o.w; $('rh').value = o.h; }
  },
  // The Compress card's slider is quality for types that lose a little (JPEG, WebP, HEIC, AVIF) and colors for
  // the ones that keep every pixel (PNG, GIF, TIFF, icons).
  onFormat(ext) {
    this.ccExt = ext + state.q + state.colors;
    const lossy = LOSSY.includes(ext);
    if (ext === 'bmp') {
      this.cc.hideSlider();
      this.cc.note('BMP keeps every pixel as it is, so it can’t be made smaller. PNG keeps them too, in far less space.');
    } else if (lossy) {
      const le = liveEdit();
      this.cc.slider({ label: 'Quality', min: 10, max: 100, value: Math.round(state.q * 100), unit: '%',
        onInput: (v) => { le.input({ ...state, q: v / 100 }); changed(); }, onChange: () => le.done() });
      this.cc.note('Lower quality, smaller file. Around 70–85% looks the same on most screens.');
    } else {
      const le = liveEdit();
      this.cc.slider({ label: 'Colors', min: 0, max: 100, value: state.colors, fmt: (v) => (colorsAt(v) ? `${colorsAt(v)} colors` : 'All colors'),
        onInput: (v) => { le.input({ ...state, colors: v }); this.draw(); changed(); }, onChange: () => le.done() });
      this.cc.note(`Fewer colors make a smaller ${ext.toUpperCase()}. Flat pictures (icons, screenshots) barely change down to 64 or so.`);
    }
    this.draw();
    this.cc.soon(60);
  },
  estimateSoon() { this.cc?.soon(); },
  // Encoded the way saving does it. The last one is kept, so saving straight after costs nothing more.
  async encode(ext, list) {
    const key = JSON.stringify([this.sig, this.mver, state.q, state.colors, ext, list, state.adj, state.out, state.crop, state.rot, state.fh, state.fv]);
    if (this.enc?.key === key) return this.enc.value;
    const colors = this.colorsFor(ext);
    const encoded = ext === 'jpg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
    const flat = encoded === 'jpeg' || ['bmp', 'pdf'].includes(ext); // no see-through in these
    const out = [];
    for (const i of list) {
      let c = this.render(i);
      if (colors) c = quantize(c, colors);
      if (flat) { const f = new OffscreenCanvas(c.width, c.height), x = f.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(c, 0, 0); c = f; }
      out.push({ blob: await c.convertToBlob({ type: `image/${encoded}`, quality: state.q }), delay: this.frames[i].delay || 0.1, dpi: this.frames[i].dpi });
    }
    const value = out.length === 1
      ? { blob: out[0].blob, job: { bytes: await out[0].blob.arrayBuffer(), encoded } }
      : { job: { frames: await Promise.all(out.map(async (f) => ({ bytes: await f.blob.arrayBuffer(), delay: f.delay, dpi: f.dpi }))), encoded: 'png', loop: F.loop || 0 } };
    this.enc = { key, value };
    return value;
  },
  async estimate() {
    const ext = fmt();
    if (ext === F.own && JSON.stringify(state) === base) return F.size; // saved untouched, it stays as it is
    const { blob, job } = await this.encode(ext, this.frameList(ext));
    if (blob && { png: 'png', jpg: 'jpeg', webp: 'webp' }[ext] === job.encoded) return blob.size;
    const r = await scrawl.invoke('tweak:estimate', { ...job, ext, quality: state.q });
    return r?.size ?? null;
  },
  async job(ext) {
    const { job } = await this.encode(ext, this.frameList(ext));
    return { kind: 'image', ...job, quality: state.q };
  },
  info() {
    const o = this.outSize();
    let s = `${o.w} × ${o.h}`;
    if (this.multi) s += this.keeps(fmt()) ? `, all ${this.frameList(fmt()).length} ${this.what}s` : `, ${this.what} ${this.fi + 1} of ${this.frames.length} only`;
    return s;
  },
  keys(e) {
    if ((e.key === 'Escape' || e.key === 'Enter') && this.crop.isLive()) { this.crop.live(false); this.cropUI.sync(); this.syncTools(); this.draw(); return true; }
    if ((e.key === 'Escape' || e.key === 'Enter') && this.selPaste) { this.sel = null; this.selPaste = null; this.placeSel(); return true; }
    if (e.key === 'Escape' && this.sel) { this.sel = null; this.placeSel(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { this.clearSel(); return true; }
    if (e.key === 'Enter' && this.sel) { this.cropToSel(); return true; }
    if (this.selPaste && e.key.startsWith('Arrow')) { // nudge the pasted picture (⇧ for 10)
      const n = e.shiftKey ? 10 : 1, c = this.sel;
      const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
      const box = { ...c, x: c.x + dx, y: c.y + dy };
      commit({ ...state, marks: state.marks.map((m) => (m.t === 'img' && m.id === this.selPaste ? this.boxToPaste(m, box) : m)) });
      this.sel = box; this.placeSel(); return true;
    }
    if (this.sel && e.key.startsWith('Arrow')) { // nudge the box (⇧ for 10)
      const r = this.cropRect(), n = e.shiftKey ? 10 : 1, c = this.sel;
      const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
      this.sel = { ...c, x: clamp(c.x + dx, r.x, r.x + r.w - c.w), y: clamp(c.y + dy, r.y, r.y + r.h - c.h) };
      this.placeSel(); return true;
    }
    if (this.multi && (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft')) { this.stop(); this.show(this.fi + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1)); return true; }
    if (e.key === ' ' && this.multi && $('fplay')) { this.playing ? this.stop() : this.play(); return true; }
    const k = { s: 'select', p: 'pen', b: 'pen', e: 'erase' }[e.key];
    if (k && !this.crop.isLive()) { this.tool = k; if (k !== 'select') { this.sel = null; this.placeSel(); } this.syncTools(); return true; }
    return false;
  },
  // ⌘ keys: zoom, select all, copy and cut.
  cmdKeys(e) {
    if (e.key === '=' || e.key === '+') { this.zoomStep(1); return true; }
    if (e.key === '-') { this.zoomStep(-1); return true; }
    if (e.key === '9') { this.setZoom(null); return true; }
    if (this.crop.isLive()) return false;
    if (e.key === 'a') { const r = this.cropRect(); this.tool = 'select'; this.selPaste = null; this.sel = { ...r }; this.placeSel(); return true; }
    if (e.key === 'c' && this.sel) { this.copySel(); return true; }
    if (e.key === 'x' && this.sel) { this.copySel(true); return true; }
    if (e.key === 'v') { this.paste(); return true; }
    return false;
  },
};

// ============ video and sound: the shared timeline ============
function timeline(host, media, { onSeek, getRange, setRange, begin, end }) {
  const tl = el('div', 'timeline', `<button class="play" id="play" aria-label="Play">${icon('play')}</button>
    <div class="track" id="track"><div class="strip" id="strip"></div><div class="out-l" id="outL"></div><div class="out-r" id="outR"></div>
    <div class="trim l" id="trimL" title="Start"></div><div class="trim r" id="trimR" title="End"></div><div class="head" id="head"></div></div>
    <div class="clock" id="clock"></div>`);
  host.append(tl);
  const track = $('track'), D = () => media.duration || 1;
  const pos = (t) => `${(t / D()) * 100}%`;
  // Scrubbing: a new seek cancels one still under way, so seeking on every pointer move showed nothing
  // until you stopped. Instead one seek runs at a time, and when it lands the latest spot is next, so the
  // picture keeps up as you drag. The playhead follows the pointer straight away.
  let want = null;
  // Played to the end: the browser stops a moment before the last redraw, and some files say they're a little
  // longer than they play. So the head is parked at the end itself until you play or seek again.
  let parked = null;
  const seekTo = (t) => {
    parked = null;
    want = t;
    if (!media.seeking) { media.currentTime = t; want = null; }
    place();
  };
  media.addEventListener('seeked', () => { if (want != null) { const t = want; want = null; media.currentTime = t; } });
  const now = () => want ?? parked ?? media.currentTime;
  function place() {
    const { start, end } = getRange();
    $('trimL').style.left = pos(start); $('trimR').style.left = pos(end);
    $('outL').style.width = pos(start); $('outR').style.width = `${(1 - end / D()) * 100}%`;
    $('head').style.left = pos(now());
    $('clock').innerHTML = `<b>${fmtTime(now())}</b> / ${fmtTime(end - start)}`;
  }
  const at = (ev) => clamp(((ev.clientX - track.getBoundingClientRect().left) / track.clientWidth) * D(), 0, D());
  for (const side of ['L', 'R']) {
    const h = $(`trim${side}`);
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      begin?.();
      const move = (ev) => {
        const t = at(ev), r = getRange();
        if (side === 'L') setRange({ start: clamp(t, 0, r.end - 0.1), end: r.end });
        else setRange({ start: r.start, end: clamp(t, r.start + 0.1, D()) });
        seekTo(side === 'L' ? getRange().start : getRange().end);
        onSeek?.(now());
      };
      const up = () => { h.removeEventListener('pointermove', move); end?.(); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
    });
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('trim')) return;
    track.setPointerCapture(e.pointerId);
    const go = (ev) => { seekTo(at(ev)); onSeek?.(now()); };
    go(e);
    track.addEventListener('pointermove', go);
    track.addEventListener('pointerup', () => track.removeEventListener('pointermove', go), { once: true });
  });
  const play = () => {
    const { start, end } = getRange();
    if (media.paused) { if (media.currentTime < start || media.currentTime >= end - 0.05) media.currentTime = start; media.play(); } else media.pause();
  };
  $('play').addEventListener('click', (e) => { e.currentTarget.blur(); play(); });
  media.addEventListener('play', () => { parked = null; $('play').innerHTML = icon('pause'); loop(); });
  media.addEventListener('pause', () => { $('play').innerHTML = icon('play'); place(); });
  media.addEventListener('ended', () => { parked = getRange().end; $('play').innerHTML = icon('play'); place(); media.dispatchEvent(new Event('parked')); });
  // While playing: stay inside the trimmed part, looping back to its start.
  function loop() {
    if (media.paused) return;
    const { start, end } = getRange();
    if (media.currentTime >= end) media.currentTime = start;
    place();
    requestAnimationFrame(loop);
  }
  media.addEventListener('seeked', place);
  return { place, play, now, strip: $('strip') };
}
function trimGroup(media, { getRange, commitRange, tl }) {
  const g = group('Trim', '<button class="link" data-reset>Reset</button>');
  g.insertAdjacentHTML('beforeend', '<div class="pair"><div class="field"><label for="ts">Start</label><input class="num" id="ts" type="text"></div><span></span><div class="field"><label for="te">End</label><input class="num" id="te" type="text"></div></div>');
  const row = el('div', 'row fill');
  row.append(button('Start here (I)', () => commitRange({ start: Math.min(media.currentTime, getRange().end - 0.1), end: getRange().end }), 'tbtn sm'),
    button('End here (O)', () => commitRange({ start: getRange().start, end: Math.max(media.currentTime, getRange().start + 0.1) }), 'tbtn sm'));
  g.append(row);
  const parse = (s) => { const p = String(s).split(':').map(Number); return p.some(isNaN) ? null : p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
  $('ts').addEventListener('change', () => { const v = parse($('ts').value); if (v != null) commitRange({ start: clamp(v, 0, getRange().end - 0.1), end: getRange().end }); });
  $('te').addEventListener('change', () => { const v = parse($('te').value); if (v != null) commitRange({ start: getRange().start, end: clamp(v, getRange().start + 0.1, media.duration) }); });
  g.querySelector('[data-reset]').addEventListener('click', () => commitRange({ start: 0, end: media.duration }));
  return { sync: () => { const r = getRange(); $('ts').value = fmtTime(r.start); $('te').value = fmtTime(r.end); tl.place(); } };
}
function waitMeta(media) {
  return new Promise((res, rej) => {
    if (media.readyState >= 1) return res();
    media.addEventListener('loadedmetadata', res, { once: true });
    media.addEventListener('error', () => rej(new Error('Pane can’t play this file to show it.')), { once: true });
  });
}

// How hard saving squeezes a video or a song: Quality 100 keeps it as it is; lower writes it again at a lower bit
// rate (and, lower still, smaller on screen). These are the helper's numbers (native/pane-files, squeeze*), so
// the estimate matches what saving does.
const sqLong = (q) => (q < 0.2 ? 960 : q < 0.45 ? 1280 : q < 0.7 ? 1920 : null);
const sqBpp = (q) => 0.025 + 0.2 * q;
const sqAudio = (q, src) => { let r = q < 0.25 ? 64000 : q < 0.5 ? 96000 : q < 0.75 ? 128000 : 160000; if (src > 64000) r = Math.min(r, Math.max(64000, Math.floor(src / 32000) * 32000)); return r; };
const M4A_RATE = 256000; // what macOS's own M4A export writes
function mediaEstimate(P, kind, ext) {
  if (!P || !state || ext === 'gif') return null;
  const dur = Math.max(0, state.end - state.start), q = (state.squeeze ?? 100) / 100, aSrc = P.aRate || 0;
  if (['wav', 'aiff', 'caf'].includes(ext)) return (P.sampleRate || 44100) * Math.max(1, P.channels || 2) * 2 * dur + 4096;
  if (kind === 'audio' || ext === 'm4a') {
    const r = q < 0.999 ? sqAudio(q, aSrc) : F.own === 'm4a' && (state.vol ?? 1) >= 0.999 ? aSrc : M4A_RATE;
    return (r * dur) / 8 + 4096;
  }
  let w = P.w || 0, h = P.h || 0;
  if (state.crop) { w = state.crop.w; h = state.crop.h; }
  const area = P.w && P.h ? (w * h) / (P.w * P.h) : 1, a = state.mute ? 0 : aSrc;
  if (q >= 0.999) return (((P.vRate || 0) * area + a) * dur) / 8 + 8192;
  const cap = sqLong(q);
  if (cap && w && h) { const k = Math.min(1, cap / Math.max(w, h), (cap * 9) / 16 / Math.min(w, h)); w *= k; h *= k; }
  let vb = Math.max(300000, w * h * (P.fps || 30) * sqBpp(q));
  if (P.vRate) vb = Math.min(vb, Math.max(300000, P.vRate * 0.95));
  const ab = state.mute || !aSrc ? 0 : sqAudio(q, aSrc);
  return (((vb + ab) * dur) / 8) * 1.12 + 8192; // encoders run a little over their target
}
function squeezeCard(kind) {
  let probe = null;
  const P = () => (probe ??= scrawl.invoke('tweak:probe'));
  let ext = '';
  const cc = compressCard({ estimate: async () => mediaEstimate(await P(), kind, ext) });
  const toM4A = button('Save as M4A instead', () => setFormat('m4a'), 'tbtn sm');
  cc.g.append(toM4A);
  const le = liveEdit();
  const sync = () => {
    const lossless = ['wav', 'aiff', 'caf'].includes(ext);
    const soundOut = kind === 'audio' || ext === 'm4a';
    toM4A.hidden = !lossless;
    if (lossless) { cc.hideSlider(); cc.note(`${ext.toUpperCase()} keeps every sample, so it can’t be made smaller.`); return; }
    const v = state.squeeze ?? 100, q = v / 100;
    cc.slider({ label: 'Quality', min: 0, max: 100, value: v, fmt: (x) => (x >= 100 ? 'As it is' : `${x}%`),
      onInput: (x) => { le.input({ ...state, squeeze: x }); sync(); changed(); }, onChange: () => le.done() });
    const cap = sqLong(q);
    cc.note(q >= 0.999 ? 'Keeps the quality it has. Slide left to make it smaller.'
      : soundOut ? `Sound at ${sqAudio(q, 0) / 1000} kbps. ${q >= 0.5 ? 'Sounds the same to most ears.' : 'Fine for voices.'}`
        : `${cap ? `At most ${cap} × ${(cap * 9) / 16}. ` : ''}${q >= 0.6 ? 'Looks the same on most screens.' : q >= 0.3 ? 'Good for sending.' : 'Small, and softer.'}`);
  };
  return { sync, soon: () => cc.soon(), onFormat: (e) => { ext = e; cc.g.hidden = e === 'gif'; sync(); cc.soon(60); } };
}

// ============ video ============
const VideoKind = {
  async init() {
    stage.innerHTML = '<div class="canvas-wrap" id="wrap"><div class="frame enter" id="frame"><video id="video" preload="auto" playsinline></video></div></div>';
    const v = $('video');
    v.src = F.url;
    this.v = v;
    await waitMeta(v);
    this.W = v.videoWidth; this.H = v.videoHeight;
    state = { start: 0, end: v.duration, crop: null, rot: 0, fh: false, fv: false, vol: 1, mute: false, gifFps: 12, gifWidth: 480, squeeze: 100 };
    this.crop = cropBox($('frame'), {
      size: () => ({ w: this.W, h: this.H }), get: () => state.crop,
      set: (r) => { state.crop = r; },
      begin: () => { this.before = JSON.stringify(state); },
      end: () => { if (this.before !== JSON.stringify(state)) { hist.past.push(this.before); hist.future = []; changed(); } },
      ratio: () => this.cropUI.ratio(),
    });
    const range = () => ({ start: state.start, end: state.end });
    let pre = null;
    this.tl = timeline(stage, v, {
      getRange: range, setRange: (r) => { state = { ...state, ...r }; },
      begin: () => { pre = JSON.stringify(state); }, end: () => { if (pre !== JSON.stringify(state)) { hist.past.push(pre); hist.future = []; changed(); this.trim.sync(); } },
    });
    this.tools(range);
    new ResizeObserver(() => this.layout()).observe($('wrap'));
    this.filmstrip();
    this.apply();
  },
  layout() {
    const wrap = $('wrap');
    if (!wrap || !state) return; // between files (after a save reopens it), the last one's watcher may still fire
    const turned = state.rot % 180 && !this.crop.isLive();
    const aw = wrap.clientWidth - 68, ah = wrap.clientHeight - 68;
    const k = turned ? Math.min(aw / this.H, ah / this.W) : Math.min(aw / this.W, ah / this.H);
    this.v.style.width = `${Math.round(this.W * k)}px`; this.v.style.height = `${Math.round(this.H * k)}px`;
    // Cropping works on the upright picture; the turn and flips show again after.
    $('frame').style.transform = this.crop.isLive() ? 'none' : `scale(${state.fh ? -1 : 1}, ${state.fv ? -1 : 1}) rotate(${state.rot}deg)`;
    this.crop.place(k);
  },
  apply() {
    this.layout();
    this.v.volume = state.vol; this.v.muted = state.mute;
    this.trim.sync(); this.cropUI.sync(); this.soundUI?.(); this.sizeUI?.sync();
  },
  async filmstrip() {
    // A row of frames along the timeline, pulled from a second copy of the video.
    const strip = this.tl.strip, n = 12;
    const probe = document.createElement('video');
    probe.muted = true; probe.preload = 'auto'; probe.src = F.url;
    try { await waitMeta(probe); } catch { return; }
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = 120; c.height = Math.round((120 * this.H) / this.W) || 68;
      strip.append(c);
    }
    for (let i = 0; i < n; i++) {
      await new Promise((r) => { probe.currentTime = ((i + 0.5) / n) * probe.duration; probe.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); });
      strip.children[i]?.getContext('2d').drawImage(probe, 0, 0, strip.children[i].width, strip.children[i].height);
    }
    probe.removeAttribute('src'); probe.load();
  },
  tools(range) {
    this.trim = trimGroup(this.v, { getRange: range, commitRange: (r) => commit({ ...state, ...r }), tl: this.tl });
    this.sizeUI = squeezeCard('video'); // high up: making a clip small enough to send is a common reason to be here
    this.cropUI = cropGroup({
      size: () => ({ w: this.W, h: this.H }), live: () => this.crop.isLive(),
      getCrop: () => state.crop, setCrop: (r) => commit({ ...state, crop: r }),
      onLive: (on) => { this.crop.live(on); this.layout(); this.cropUI.sync(); },
    });
    const turn = group('Turn and flip');
    const row = el('div', 'row fill');
    row.append(button(icon('left'), () => commit({ ...state, rot: (state.rot + 270) % 360 })), button(icon('right'), () => commit({ ...state, rot: (state.rot + 90) % 360 })),
      button(icon('flipH'), () => commit({ ...state, fh: !state.fh })), button(icon('flipV'), () => commit({ ...state, fv: !state.fv })));
    [...row.children].forEach((b, i) => b.title = ['Turn left', 'Turn right', 'Flip across', 'Flip upside down'][i]);
    turn.append(row);

    const snd = group('Sound');
    let pre = null;
    const vol = slider(snd, { label: 'Volume', min: 0, max: 100, value: 100, unit: '%', onInput: (x) => { pre ??= JSON.stringify(state); state = { ...state, vol: x / 100 }; this.v.volume = state.vol; }, onChange: () => { if (pre !== JSON.stringify(state)) { hist.past.push(pre); hist.future = []; changed(); } pre = null; } });
    const mute = switchLine(snd, 'Mute', false, (m) => commit({ ...state, mute: m }));
    snd.append(button(`${icon('note')}<span>Save just the sound</span>`, () => { setFormat('m4a'); toast('Saving as M4A sound. Pick WAV, AIFF or CAF under Save as.'); }));
    this.soundUI = () => { vol.set(Math.round(state.vol * 100)); mute.set(state.mute); };

    const fr = group('Frame');
    fr.append(el('p', 'note', 'Saves the picture under the playhead as a PNG beside the video.'));
    fr.append(button(`${icon('camera')}<span>Save this frame</span>`, async () => {
      const r = await scrawl.invoke('tweak:frame', this.v.currentTime);
      if (r?.ok) toast(`Saved ${r.name}`, r.path); else toast(r?.error || 'Couldn’t save the frame.', null, true);
    }));

    this.gif = group('GIF');
    slider(this.gif, { label: 'Frames a second', min: 4, max: 24, value: 12, onChange: (x) => { state = { ...state, gifFps: x }; } });
    slider(this.gif, { label: 'Width', min: 160, max: 960, step: 40, value: 480, unit: ' px', onChange: (x) => { state = { ...state, gifWidth: x }; } });
  },
  onFormat(ext) { this.gif.hidden = ext !== 'gif'; this.sizeUI.onFormat(ext); },
  estimateSoon() { this.sizeUI?.soon(); },
  async job() {
    return { kind: 'media', ops: { start: state.start, end: state.end, crop: state.crop ? [state.crop.x, state.crop.y, state.crop.w, state.crop.h] : null, rotate: state.rot, flipH: state.fh, flipV: state.fv, volume: state.vol, mute: state.mute, gifFps: state.gifFps, gifWidth: state.gifWidth, quality: (state.squeeze ?? 100) / 100 } };
  },
  info() { const c = state.crop; return `${fmtTime(state.end - state.start)}${c ? `, ${c.w} × ${c.h}` : ''}`; },
  keys(e) {
    if (e.key === ' ') { this.tl.play(); return true; }
    if (e.key === 'i') { commit({ ...state, start: Math.min(this.v.currentTime, state.end - 0.1) }); return true; }
    if (e.key === 'o') { commit({ ...state, end: Math.max(this.v.currentTime, state.start + 0.1) }); return true; }
    if ((e.key === 'Escape' || e.key === 'Enter') && this.crop.isLive()) { this.crop.live(false); this.layout(); this.cropUI.sync(); return true; }
    return false;
  },
};

// ============ sound ============
const AudioKind = {
  async init() {
    stage.innerHTML = `<div class="wave-wrap enter" id="wrap"><div class="wave-title">${icon('note')}<span id="wname"></span><small id="wlen"></small></div><canvas id="wave"></canvas></div>`;
    $('wname').textContent = F.name;
    const a = new Audio();
    a.src = F.url; a.preload = 'auto';
    this.a = a;
    await waitMeta(a);
    state = { start: 0, end: a.duration, vol: 1, squeeze: 100 };
    let pre = null;
    const range = () => ({ start: state.start, end: state.end });
    // Dragging along the timeline: the wave follows, and a moment of sound plays where you are.
    let blip = 0;
    const scrubSound = () => {
      if (!a.paused && !blip) return; // already playing on its own
      const t = Date.now();
      if (t - (this.lastBlip || 0) < 110) return;
      this.lastBlip = t;
      clearTimeout(blip);
      a.play().catch(() => {});
      blip = setTimeout(() => { a.pause(); blip = 0; }, 90);
    };
    this.tl = timeline(stage, a, {
      onSeek: () => { this.drawWave(); scrubSound(); },
      getRange: range, setRange: (r) => { state = { ...state, ...r }; this.drawWave(); },
      begin: () => { pre = JSON.stringify(state); }, end: () => { if (pre !== JSON.stringify(state)) { hist.past.push(pre); hist.future = []; changed(); this.trim.sync(); } },
    });
    this.trim = trimGroup(a, { getRange: range, commitRange: (r) => commit({ ...state, ...r }), tl: this.tl });
    const snd = group('Volume');
    let p2 = null;
    this.vol = slider(snd, { label: 'Quieter', min: 0, max: 100, value: 100, unit: '%', onInput: (x) => { p2 ??= JSON.stringify(state); state = { ...state, vol: x / 100 }; a.volume = state.vol; this.drawWave(); }, onChange: () => { if (p2 !== JSON.stringify(state)) { hist.past.push(p2); hist.future = []; changed(); } p2 = null; } });
    snd.append(el('p', 'note', 'Turns the whole file down. 100% leaves it as it is.'));
    this.sizeUI = squeezeCard('audio');
    a.addEventListener('timeupdate', () => this.drawWave());
    a.addEventListener('parked', () => this.drawWave()); // played to the end: the wave fills to the end too
    new ResizeObserver(() => this.drawWave()).observe($('wrap'));
    this.peaks = await this.loadPeaks();
    this.apply();
  },
  async loadPeaks() {
    try {
      const buf = await scrawl.invoke('tweak:bytes');
      if (!buf) return null;
      const ctx = new OfflineAudioContext(1, 2, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0), n = 600, step = Math.floor(ch.length / n) || 1, out = new Float32Array(n);
      for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 8) m = Math.max(m, Math.abs(ch[j])); out[i] = m; }
      return out;
    } catch { return null; }
  },
  drawWave() {
    const c = $('wave');
    if (!c || !state) return;
    const dpr = DPR(), W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    const D = this.a.duration || 1, p = this.peaks;
    const bars = Math.floor(W / 5);
    for (let i = 0; i < bars; i++) {
      const t = (i / bars) * D;
      const v = p ? p[Math.floor((i / bars) * p.length)] : 0.3 + 0.25 * Math.sin(i * 0.7) * Math.sin(i * 0.13);
      const h = Math.max(3, v * (H - 8) * (0.15 + 0.85 * state.vol));
      const inside = t >= state.start && t <= state.end;
      ctx.fillStyle = !inside ? 'rgba(255,255,255,0.14)' : t <= (this.tl?.now() ?? this.a.currentTime) ? '#CDEB5A' : 'rgba(205,235,90,0.42)';
      ctx.beginPath(); ctx.roundRect(i * 5, (H - h) / 2, 3, h, 1.5); ctx.fill();
    }
    $('wlen').textContent = `${fmtTime(state.end - state.start)} of ${fmtTime(D)}`;
    // The small strip on the timeline: the same shape, quieter.
    const strip = this.tl.strip;
    if (p && !strip.firstChild) {
      strip.classList.add('bars');
      const s = document.createElement('canvas');
      s.width = 800; s.height = 92;
      const sc = s.getContext('2d');
      sc.fillStyle = 'rgba(205,235,90,0.55)';
      for (let i = 0; i < 200; i++) { const v = p[Math.floor((i / 200) * p.length)]; const h = Math.max(2, v * 84); sc.fillRect(i * 4, (92 - h) / 2, 2.5, h); }
      strip.append(s);
    }
  },
  apply() { this.a.volume = state.vol; this.vol.set(Math.round(state.vol * 100)); this.trim.sync(); this.sizeUI.sync(); this.drawWave(); },
  onFormat(ext) { this.sizeUI.onFormat(ext); },
  estimateSoon() { this.sizeUI?.soon(); },
  async job() { return { kind: 'media', ops: { start: state.start, end: state.end, volume: state.vol, quality: (state.squeeze ?? 100) / 100 } }; },
  info() { return fmtTime(state.end - state.start); },
  keys(e) {
    if (e.key === ' ') { this.tl.play(); return true; }
    if (e.key === 'i') { commit({ ...state, start: Math.min(this.a.currentTime, state.end - 0.1) }); return true; }
    if (e.key === 'o') { commit({ ...state, end: Math.max(this.a.currentTime, state.start + 0.1) }); return true; }
    return false;
  },
};

// ============ words ============
// A tiny Markdown reader, for the preview and for saving Markdown as a web page.
function markdown(src) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = []; let list = null, code = null, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.split('\n')) {
    if (code !== null) { if (/^```/.test(line)) { out.push(`<pre><code>${esc(code)}</code></pre>`); code = null; } else code += `${line}\n`; continue; }
    if (/^```/.test(line)) { flush(); code = ''; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = /^\s*[-*+]\s+(.*)/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = /^>\s?(.*)/.exec(line))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (!line.trim()) { flush(); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${esc(code)}</code></pre>`);
  flush();
  return out.join('\n');
}
const pageFor = (body, title) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1b1d3a}code,pre{font-family:ui-monospace,Menlo,monospace;background:#f1f2f8;border-radius:6px}code{padding:1px 5px}pre{padding:12px 14px;overflow:auto}img{max-width:100%}blockquote{margin:0;padding-left:14px;border-left:3px solid #cdeb5a;color:#5f6386}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
// CSV to and from a list of objects (quoted fields and commas inside quotes handled).
function parseCSV(text, sep = ',') {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...rest] = rows.filter((r) => r.some((x) => x !== ''));
  return (rest || []).map((r) => Object.fromEntries((head || []).map((h, i) => [h, r[i] ?? ''])));
}
function toCSV(list) {
  const cols = [...new Set(list.flatMap((o) => Object.keys(o)))];
  const cell = (v) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(cell).join(','), ...list.map((o) => cols.map((c) => cell(o[c])).join(','))].join('\n') + '\n';
}

const TextKind = {
  text: true,
  async init() {
    stage.classList.add('texty');
    stage.innerHTML = '<div class="text-wrap" id="twrap"><div class="gutter" id="gutter">1</div><textarea id="text" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div><div class="textbar"><span id="tpos">Line 1, column 1</span><span id="tcount"></span><span class="grow"></span><span id="tnote"></span></div>';
    const t = $('text');
    t.value = F.text;
    this.orig = F.text;
    this.t = t;
    const prose = ['txt', 'md', 'markdown', 'rtf', 'doc', 'docx', 'odt', 'webarchive', 'wordml', ''].includes(F.ext);
    if (F.kind === 'rich') $('tnote').textContent = 'Opened as plain text. Formatting isn’t kept.';
    t.addEventListener('input', () => { this.lines(); changed(); this.preview(); });
    t.addEventListener('scroll', () => { $('gutter').scrollTop = t.scrollTop; });
    t.addEventListener('keyup', () => this.pos());
    t.addEventListener('click', () => this.pos());
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.metaKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    });
    this.tools(prose);
    if (prose) this.setProse(true);
    state = {};
    t.focus(); t.setSelectionRange(0, 0);
    this.lines(); this.pos();
  },
  dirty() { return this.t.value !== this.orig; },
  apply() {},
  lines() {
    const n = this.t.value.split('\n').length;
    if (n !== this.n) { this.n = n; $('gutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
    const v = this.t.value;
    const words = (v.match(/\S+/g) || []).length;
    $('tcount').textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}, ${v.length.toLocaleString()} character${v.length === 1 ? '' : 's'}`;
  },
  pos() {
    const before = this.t.value.slice(0, this.t.selectionStart).split('\n');
    $('tpos').textContent = `Line ${before.length}, column ${before.at(-1).length + 1}`;
  },
  // Replace text through the editing commands, so ⌘Z undoes it like typing.
  replaceAll(next) {
    const t = this.t;
    t.focus();
    t.select();
    document.execCommand('insertText', false, next);
    t.setSelectionRange(0, 0);
    this.lines(); changed(); this.preview();
  },
  transform(fn) {
    const t = this.t, a = t.selectionStart, b = t.selectionEnd;
    if (a !== b) { t.focus(); document.execCommand('insertText', false, fn(t.value.slice(a, b))); t.setSelectionRange(a, a + fn(t.value.slice(a, b)).length); this.lines(); changed(); this.preview(); }
    else this.replaceAll(fn(t.value));
  },
  setProse(on) { this.t.classList.toggle('prose', on); this.t.classList.toggle('wrap', on || this.wrapOn); $('twrap').classList.toggle('prose', on); this.proseOn = on; this.proseSw?.set(on); },
  preview() {
    if (!this.previewOn) return;
    const f = $('pframe');
    const html = ['md', 'markdown'].includes(F.ext) ? pageFor(markdown(this.t.value), '') : this.t.value;
    clearTimeout(this.pt);
    this.pt = setTimeout(() => { f.srcdoc = html; }, 120);
  },
  tools(prose) {
    const fg = group('Find and replace', '<span class="count" id="fcount"></span>');
    fg.insertAdjacentHTML('beforeend', '<input class="txt" id="find" placeholder="Find" spellcheck="false"><input class="txt" id="repl" placeholder="Replace with" spellcheck="false">');
    const frow = el('div', 'row fill');
    const caseBtn = button('Aa', () => { caseBtn.classList.toggle('on'); count(); }, 'tbtn sm');
    caseBtn.title = 'Match upper and lower case';
    const rx = (g = 'g') => { const f = $('find').value; return f ? new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), g + (caseBtn.classList.contains('on') ? '' : 'i')) : null; };
    const count = () => { const r = rx(); const n = r ? (this.t.value.match(r) || []).length : 0; $('fcount').textContent = $('find').value ? `${n} found` : ''; };
    const next = () => {
      const r = rx(); if (!r) return;
      const from = this.t.selectionEnd;
      r.lastIndex = from;
      let m = r.exec(this.t.value);
      if (!m) { r.lastIndex = 0; m = r.exec(this.t.value); }
      if (m) { this.t.focus(); this.t.setSelectionRange(m.index, m.index + m[0].length); this.pos(); const line = this.t.value.slice(0, m.index).split('\n').length; this.t.scrollTop = Math.max(0, (line - 6) * 20.8); }
    };
    frow.append(caseBtn, button('Next', next, 'tbtn sm'), button('Replace all', () => {
      const r = rx(); if (!r) return;
      const n = (this.t.value.match(r) || []).length;
      if (!n) return;
      this.replaceAll(this.t.value.replace(r, $('repl').value.replace(/\$/g, '$$$$')));
      $('fcount').textContent = `Replaced ${n}`;
    }, 'tbtn sm go'));
    fg.append(frow);
    $('find').addEventListener('input', count);
    $('find').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });

    const cg = group('Change text');
    cg.append(el('p', 'note', 'Works on what you’ve selected, or on everything.'));
    const r1 = el('div', 'row fill'), r2 = el('div', 'row fill'), r3 = el('div', 'row fill');
    const title = (s) => s.toLowerCase().replace(/(^|[\s\-_(“"'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    r1.append(button('UPPER', () => this.transform((s) => s.toUpperCase()), 'tbtn sm'), button('lower', () => this.transform((s) => s.toLowerCase()), 'tbtn sm'), button('Title', () => this.transform(title), 'tbtn sm'));
    const lines = (fn) => (s) => { const end = s.endsWith('\n'); const out = fn(s.replace(/\n$/, '').split('\n')).join('\n'); return end ? `${out}\n` : out; };
    r2.append(button('Sort lines', () => this.transform(lines((l) => l.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })))), 'tbtn sm'),
      button('Reverse', () => this.transform(lines((l) => l.slice().reverse())), 'tbtn sm'));
    r3.append(button('Remove repeats', () => this.transform(lines((l) => [...new Set(l)])), 'tbtn sm'), button('Trim spaces', () => this.transform(lines((l) => l.map((x) => x.replace(/[ \t]+$/g, '')))), 'tbtn sm'));
    cg.append(r1, r2, r3);

    let parsed = null;
    try { parsed = JSON.parse(F.text); } catch {}
    if (parsed !== null || F.ext === 'json') {
      const jg = group('JSON');
      const jrow = el('div', 'row fill');
      const tidy = (space) => { try { this.replaceAll(`${JSON.stringify(JSON.parse(this.t.value), null, space)}\n`); } catch (err) { toast(`Not valid JSON: ${err.message.replace(/^JSON\.parse: /, '')}`, null, true); } };
      jrow.append(button('Tidy', () => tidy(2), 'tbtn sm'), button('Squash', () => tidy(0), 'tbtn sm'));
      jg.append(jrow);
    }

    this.zipLevel = 6;
    const cc = compressCard({ estimate: async () => {
      const r = await scrawl.invoke('tweak:zipEstimate', { text: F.kind === 'rich' && !this.dirty() ? undefined : this.t.value, level: this.zipLevel, name: `${F.stem}.${F.own}` });
      return r?.size ?? null;
    } });
    cc.slider({ label: 'Packing', min: 1, max: 9, value: 6, fmt: (v) => (v <= 2 ? 'Quick' : v >= 8 ? 'Smallest' : `Level ${v}`), onInput: (v) => { this.zipLevel = v; cc.soon(); } });
    const zb = button('Save as ZIP', () => setFormat('zip'), 'tbtn sm go');
    cc.g.append(zb);
    this.cc = cc; this.zb = zb;

    const vg = group('View');
    switchLine(vg, 'Wrap long lines', prose, (v) => { this.wrapOn = v; this.t.classList.toggle('wrap', v || this.proseOn); });
    this.wrapOn = prose;
    this.proseSw = switchLine(vg, 'Reading font', prose, (v) => this.setProse(v));
    if (['md', 'markdown', 'html', 'htm', 'svg'].includes(F.ext)) {
      switchLine(vg, 'Preview beside it', false, (v) => {
        this.previewOn = v;
        $('twrap').classList.toggle('split', v);
        $('pframe')?.parentElement.remove();
        if (v) { const p = el('div', 'preview', '<iframe id="pframe" sandbox=""></iframe>'); $('twrap').append(p); this.preview(); }
      });
    }
  },
  // Saving to another type can change what's inside, not just the name.
  convert(ext) {
    const v = this.t.value, from = F.ext;
    if (ext === 'zip') return { text: v, note: 'Packed into a ZIP.' };
    if (['md', 'markdown'].includes(from) && ext === 'html') return { text: pageFor(markdown(v), F.stem), note: 'The Markdown becomes a web page.' };
    if (['csv', 'tsv'].includes(from) && ext === 'json') { const rows = parseCSV(v, from === 'tsv' ? '\t' : ','); return { text: `${JSON.stringify(rows, null, 2)}\n`, note: `Each row becomes a JSON object (${rows.length} rows).` }; }
    if (from === 'json' && ext === 'csv') {
      try { const d = JSON.parse(v); const list = Array.isArray(d) ? d.filter((x) => x && typeof x === 'object') : [d]; if (list.length) return { text: toCSV(list), note: `Each object becomes a row (${list.length} rows).` }; } catch {}
    }
    return { text: v, note: null };
  },
  async job(ext) {
    if (ext === 'zip') return { kind: 'zip', text: this.t.value, inner: F.own, level: this.zipLevel, original: !this.dirty() };
    return { kind: 'text', text: this.convert(ext).text };
  },
  onFormat(ext) {
    this.zb.hidden = ext === 'zip';
    this.cc.note(ext === 'zip' ? `Saving packs ${F.stem}.${F.own} into a ZIP.` : 'Packs it into a ZIP. Text often shrinks to a fraction of its size.');
    this.cc.soon(60);
  },
  estimateSoon() { this.cc?.soon(700); },
  info() { return null; },
  keys() { return false; },
};

// ============ folders ============
// A folder opens like Finder: its contents as icons, a list, columns or a gallery, and what's inside it
// counted up on the right. Its name in the bar renames it. Double-click anything inside to tweak that
// instead: the folder's new name is kept first, then this window opens the file (or the folder).
const thumbs = new Map(); // path@size → data URL, Finder's own pictures
function thumb(p, size) {
  const key = `${p}@${size}`;
  if (!thumbs.has(key)) thumbs.set(key, scrawl.invoke('tweak:thumb', p, size).catch(() => null));
  return thumbs.get(key);
}
// An <img> that fills in with the thumbnail once it scrolls into view.
const seen = new IntersectionObserver((list) => {
  for (const it of list) {
    if (!it.isIntersecting) continue;
    const img = it.target;
    seen.unobserve(img);
    thumb(img.dataset.path, +img.dataset.size).then((u) => { if (u) { img.src = u; img.classList.add('in'); } });
  }
}, { rootMargin: '200px' });
function thumbImg(entry, size, cls = 'th') {
  const img = el('img', cls);
  img.alt = ''; img.draggable = false;
  img.dataset.path = entry.path; img.dataset.size = size;
  seen.observe(img);
  return img;
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const KIND_NAME = { image: 'Pictures', video: 'Videos', audio: 'Sounds', text: 'Text and documents', other: 'Other files' };
const VIEWS = [['icons', 'grid', 'Icons'], ['list', 'list', 'List'], ['columns', 'cols', 'Columns'], ['gallery', 'gallery', 'Gallery']];

const DirKind = {
  noSave: true,
  async init() {
    let view = 'icons';
    try { view = localStorage.getItem('tweak.view') || 'icons'; } catch {}
    if (!VIEWS.some(([v]) => v === view)) view = 'icons';
    state = { view };
    this.sel = null; this.cols = [F.path]; this.colSel = []; this.rendered = false;
    stage.classList.add('foldery');
    stage.innerHTML = `<div class="fbar"><button class="ibtn" id="fup" title="Up to the folder it’s in (⌘↑)">${icon('up')}</button><div class="crumbs" id="crumbs"></div><span class="grow"></span><div class="vseg" id="vseg" role="radiogroup" aria-label="View">${VIEWS.map(([v, i, n]) => `<button role="radio" data-v="${v}" title="${n}" aria-label="${n}">${icon(i)}</button>`).join('')}</div></div><div class="fview enter" id="fview"></div><div class="fstatus" id="fstatus"></div>`;
    $('fup').disabled = F.dir === F.path;
    $('fup').addEventListener('click', (e) => { e.currentTarget.blur(); go(F.dir); });
    const parts = F.path.split('/').filter(Boolean);
    const crumbs = $('crumbs');
    parts.slice(-3).forEach((name, i, arr) => {
      const at = '/' + parts.slice(0, parts.length - arr.length + i + 1).join('/');
      const b = button(name, () => { if (at !== F.path) go(at); }, 'crumb');
      if (i === arr.length - 1) b.classList.add('here');
      if (i) crumbs.append(el('span', 'sep', icon('chev')));
      crumbs.append(b);
    });
    $('vseg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      b.blur();
      state = { view: b.dataset.v };
      try { localStorage.setItem('tweak.view', state.view); } catch {}
      this.render();
    });
    const r = await scrawl.invoke('tweak:list', F.path);
    if (r?.error) throw new Error(r.error);
    this.entries = r.entries;
    this.more = r.more;
    this.lists = new Map([[F.path, r.entries]]);
    this.panel();
    this.render();
  },
  apply() {},
  info() { return null; },
  status() {
    const n = this.entries.length, sel = this.sel;
    $('fstatus').textContent = `${n.toLocaleString()} item${n === 1 ? '' : 's'}${this.more ? ' (showing the first 3,000)' : ''}` +
      (sel ? `  ·  ${sel.name} selected${sel.size != null ? `, ${fmtSize(sel.size)}` : ''}` : '');
  },
  render() {
    $('vseg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === state.view));
    const v = $('fview');
    v.className = `fview v-${state.view}${this.rendered ? '' : ' enter'}`;
    this.rendered = true;
    v.innerHTML = '';
    if (!this.entries.length) { v.append(el('div', 'fempty', `${icon('folder', 1.8)}<b>Nothing in here</b>`)); this.status(); return; }
    this[state.view](v);
    this.status();
  },
  // Clicking picks, double-clicking tweaks it.
  item(node, entry, host) {
    node.dataset.path = entry.path;
    node.addEventListener('click', () => this.pick(entry, host));
    node.addEventListener('dblclick', () => go(entry.path));
    if (this.sel?.path === entry.path) node.classList.add('on');
  },
  pick(entry) {
    this.sel = entry;
    $('fview').querySelectorAll('.on').forEach((n) => n.classList.remove('on'));
    $('fview').querySelectorAll(`[data-path="${CSS.escape(entry.path)}"]`).forEach((n) => n.classList.add('on'));
    if (state.view === 'gallery') this.hero(entry);
    this.chosen(entry);
    this.status();
  },
  icons(v) {
    for (const e of this.entries) {
      const n = el('button', 'icon');
      n.append(thumbImg(e, 160), el('span', 'nm'));
      n.lastChild.textContent = e.name;
      n.title = e.name;
      this.item(n, e);
      v.append(n);
    }
  },
  list(v) {
    const t = el('div', 'table');
    t.append(el('div', 'tr th', '<span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span>'));
    for (const e of this.entries) {
      const r = el('button', 'tr');
      const nm = el('span', 'nm');
      nm.append(thumbImg(e, 48, 'ic'), el('span'));
      nm.lastChild.textContent = e.name;
      r.append(nm, el('span', '', fmtDate(e.mtime)), el('span', '', e.dir ? '—' : fmtSize(e.size)), el('span'));
      r.lastChild.textContent = e.label;
      this.item(r, e);
      t.append(r);
    }
    v.append(t);
  },
  // Finder's columns: a folder picked in one column opens in the next; a file picked shows its preview last.
  async columns(v) {
    const row = el('div', 'cols');
    v.append(row);
    for (let i = 0; i < this.cols.length; i++) {
      const dir = this.cols[i];
      let list = this.lists.get(dir);
      if (!list) { const r = await scrawl.invoke('tweak:list', dir); list = r?.entries || []; this.lists.set(dir, list); }
      if (state.view !== 'columns' || !row.isConnected) return;
      const col = el('div', 'col');
      if (!list.length) col.append(el('p', 'cempty', 'Empty'));
      for (const e of list) {
        const r = el('button', 'cr');
        r.dataset.path = e.path;
        r.append(thumbImg(e, 48, 'ic'), el('span', 'nm'));
        r.children[1].textContent = e.name;
        if (e.dir) r.insertAdjacentHTML('beforeend', `<i>${icon('chev')}</i>`);
        if (this.colSel[i] === e.path) r.classList.add('on');
        r.addEventListener('click', () => {
          this.colSel = this.colSel.slice(0, i).concat(e.path);
          this.cols = this.cols.slice(0, i + 1).concat(e.dir ? [e.path] : []);
          this.sel = e;
          this.chosen(e);
          this.status();
          const keep = v.querySelector('.cols').scrollLeft;
          this.render();
          requestAnimationFrame(() => { const c = $('fview').querySelector('.cols'); if (c) c.scrollLeft = Math.max(keep, c.scrollWidth); });
        });
        r.addEventListener('dblclick', () => go(e.path));
        col.append(r);
      }
      row.append(col);
    }
    const last = this.sel && !this.sel.dir && this.colSel.at(-1) === this.sel.path ? this.sel : null;
    if (last) {
      const pv = el('div', 'col preview');
      pv.append(thumbImg(last, 512, 'big'), el('b'), el('small'));
      pv.children[1].textContent = last.name;
      pv.children[2].textContent = [last.label, fmtSize(last.size)].filter(Boolean).join(', ');
      pv.append(button(last.ok ? 'Tweak it' : 'Open it here', () => go(last.path), 'tbtn sm go'));
      row.append(pv);
    }
  },
  gallery(v) {
    const hero = el('div', 'hero', '<div class="pic" id="hpic"></div><div class="cap"><b id="hname"></b><small id="hsub"></small></div>');
    const strip = el('div', 'strip2');
    for (const e of this.entries) {
      const n = el('button', 'g');
      n.append(thumbImg(e, 160));
      n.title = e.name;
      this.item(n, e);
      strip.append(n);
    }
    v.append(hero, strip);
    if (!this.sel) { this.sel = this.entries[0]; strip.firstChild.classList.add('on'); this.chosen(this.sel); }
    this.hero(this.sel);
  },
  hero(e) {
    if (!$('hpic') || !e) return;
    const pic = $('hpic');
    pic.innerHTML = '';
    pic.append(thumbImg(e, 768, 'big'));
    $('hname').textContent = e.name;
    $('hsub').textContent = [e.label, e.dir ? null : fmtSize(e.size), fmtDate(e.mtime)].filter(Boolean).join('  ·  ');
    pic.ondblclick = () => go(e.path);
  },
  // The inspector: the folder's numbers, what kinds of files are in it, and what's picked.
  panel() {
    const g = group('This folder');
    const dl = el('dl', 'facts');
    const fact = (k, v, id) => { dl.insertAdjacentHTML('beforeend', `<dt>${k}</dt><dd${id ? ` id="${id}"` : ''}></dd>`); dl.lastChild.textContent = v; };
    fact('Items', `${this.entries.length.toLocaleString()}${this.more ? '+' : ''}`);
    fact('All inside', 'Counting…', 'fAll');
    fact('Size', 'Counting…', 'fSize');
    fact('Created', fmtDate(F.ctime));
    fact('Modified', fmtDate(F.mtime));
    fact('Where', F.dir);
    dl.lastChild.classList.add('where');
    dl.lastChild.title = 'Show in Finder';
    dl.lastChild.addEventListener('click', () => scrawl.send('tweak:reveal', F.path));
    g.append(dl);
    const kinds = group('What’s inside');
    kinds.append(el('p', 'note', 'Counting…'));
    scrawl.invoke('tweak:stats', F.path).then((s) => {
      if (!s || !$('fAll')) return;
      const more = s.partial ? '+' : '';
      $('fAll').textContent = `${s.files.toLocaleString()}${more} file${s.files === 1 ? '' : 's'}, ${s.folders.toLocaleString()}${more} folder${s.folders === 1 ? '' : 's'}`;
      $('fSize').textContent = `${fmtSize(s.bytes) || '0 bytes'}${s.partial ? ' or more' : ''}`;
      kinds.querySelector('.note').remove();
      const rows = Object.entries(s.kinds).sort((a, b) => b[1] - a[1]);
      if (!rows.length) { kinds.append(el('p', 'note', 'No files, only folders.')); return; }
      const max = rows[0][1];
      for (const [k, n] of rows) {
        const r = el('div', `kbar k-${k}`, '<span class="kl"></span><span class="kn"></span><i><b></b></i>');
        r.querySelector('.kl').textContent = KIND_NAME[k] || k;
        r.querySelector('.kn').textContent = n.toLocaleString();
        r.querySelector('b').style.width = `${Math.max(4, (n / max) * 100)}%`;
        kinds.append(r);
      }
      if (s.partial) kinds.append(el('p', 'note', 'A big folder: Pane stopped counting partway.'));
    });
    this.pickG = group('Picked');
    this.chosen(null);
  },
  chosen(e) {
    const g = this.pickG;
    g.querySelectorAll(':scope > :not(h3)').forEach((n) => n.remove());
    if (!e) { g.append(el('p', 'note', 'Click something to see it here. Double-click it to tweak it; this folder keeps its new name first.')); return; }
    const top = el('div', 'pickrow');
    top.append(thumbImg(e, 96, 'pt'), el('div'));
    top.lastChild.append(el('b'), el('small'));
    top.querySelector('b').textContent = e.name;
    top.querySelector('small').textContent = [e.label, e.dir ? null : fmtSize(e.size)].filter(Boolean).join(', ');
    g.append(top);
    const dl = el('dl', 'facts');
    dl.innerHTML = '<dt>Modified</dt><dd></dd><dt>Created</dt><dd></dd>';
    dl.children[1].textContent = fmtDate(e.mtime);
    dl.children[3].textContent = fmtDate(e.ctime);
    g.append(dl);
    g.append(button(e.dir ? `${icon('folder')}<span>Open this folder</span>` : e.ok ? `${icon('crop')}<span>Tweak it</span>` : `<span>Open it here</span>`, () => go(e.path), 'tbtn go'));
  },
  keys(e) {
    const list = state.view === 'columns' ? null : this.entries;
    if (e.key === 'Enter' && this.sel) { go(this.sel.path); return true; }
    if (!list || !list.length || !e.key.startsWith('Arrow')) return false;
    let i = list.findIndex((x) => x.path === this.sel?.path);
    let step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    if (state.view === 'icons' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const items = $('fview').children;
      const perRow = items.length > 1 ? [...items].findIndex((n) => n.offsetTop !== items[0].offsetTop) : 1;
      step *= perRow > 0 ? perRow : items.length;
    }
    i = i < 0 ? 0 : clamp(i + step, 0, list.length - 1);
    this.pick(list[i]);
    $('fview').querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  },
};

// Tweak something else in this window: keep this one's new name first, then open that.
async function go(p) {
  if (!(await commitName())) return;
  if (await scrawl.invoke('tweak:swap', p)) start();
}

// ---------- renaming: the name in the bar changes the file's name as soon as you're done typing ----------
let renaming = null;
function commitName() {
  if (renaming) return renaming;
  if (!F || !F.path) return Promise.resolve(true);
  const v = $('stem').value.trim();
  if (!v || v === F.stem) { $('stem').value = F.stem; changed(); return Promise.resolve(true); }
  renaming = (async () => {
    const r = await scrawl.invoke('tweak:rename', { stem: v });
    if (r?.ok) { renamed(r); toast(`Renamed to ${r.name}`, r.path); return true; }
    $('stem').value = F.stem;
    toast(r?.error || 'Couldn’t rename it.', null, true);
    changed();
    return false;
  })().finally(() => { renaming = null; });
  return renaming;
}
// The file kept its insides but moved: follow it, so playing and saving still find it.
function renamed(r) {
  const dot = r.name.lastIndexOf('.');
  const isDir = F.kind === 'dir';
  F.path = r.path; F.name = r.name;
  F.stem = isDir || dot <= 0 ? r.name : r.name.slice(0, dot);
  if (!isDir) F.ext = dot > 0 ? r.name.slice(dot + 1).toLowerCase() : '';
  F.url = `file://${r.path.split('/').map(encodeURIComponent).join('/')}`;
  $('stem').value = F.stem;
  document.title = r.name;
  const m = K?.v || K?.a;
  if (m) { const t = m.currentTime, playing = !m.paused; m.src = F.url; m.addEventListener('loadedmetadata', () => { m.currentTime = t; if (playing) m.play(); }, { once: true }); }
  if (!F.ok || isDir) $('ext').textContent = F.ext ? `.${F.ext}` : '';
  changed();
}

// ---------- save bar ----------
// "Other ending…" names the file with any ending you type. What's inside stays the type it is.
const OTHER = '__other';
const ENDING = /^[A-Za-z0-9_-]{1,15}$/;
const isOther = () => $('format').value === OTHER;
const typed = () => $('ending').value.trim().replace(/^\.+/, '');
// A typed ending that's on the menu (jpg on a picture) is written as that type, not just named it.
const fmt = () => (isOther() ? (F?.formats?.includes(typed().toLowerCase()) ? typed().toLowerCase() : F?.def) : $('format').value);
const ending = () => (isOther() ? (ENDING.test(typed()) ? typed() : F?.def) : $('format').value);
let mode = 'replace';
function setFormat(ext) { $('format').value = ext; onFormat(); }
function onFormat() {
  const other = isOther();
  syncFormat();
  $('ending').hidden = !other;
  if (other && !typed()) $('ending').value = 'jpg'; // the ending most people want; typing replaces it
  if (other && document.activeElement !== $('ending')) requestAnimationFrame(() => { $('ending').focus(); $('ending').select(); });
  K?.onFormat?.(fmt());
  $('ext').textContent = `.${ending()}`;
  changed();
}
$('format').addEventListener('change', onFormat);

// The type menu is Pane's own: a button and a list, drawn from the hidden <select>, which stays the one
// place the choice lives (so everything that reads $('format').value keeps working).
function buildFormatMenu() {
  const m = $('formatMenu');
  m.innerHTML = '';
  for (const el of $('format').children) {
    if (el.tagName === 'HR') { m.append(document.createElement('hr')); continue; }
    const v = el.value, own = v === F?.own;
    const b = document.createElement('button');
    b.className = 'opt'; b.type = 'button'; b.role = 'option'; b.dataset.value = v; b.tabIndex = -1;
    b.innerHTML = '<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="nm"></span>';
    b.querySelector('.nm').textContent = v === OTHER ? 'Other ending…' : (LABELS[v] || v.toUpperCase());
    if (own) b.insertAdjacentHTML('beforeend', '<span class="tag">as it is</span>');
    if (v !== OTHER) { const e = document.createElement('span'); e.className = 'end'; e.textContent = `.${v}`; b.append(e); }
    m.append(b);
  }
  syncFormat();
}
function syncFormat() {
  const sel = $('format'), o = sel.selectedOptions[0];
  $('formatLabel').textContent = !o ? '' : o.value === OTHER ? 'Other ending…' : (LABELS[o.value] || o.value.toUpperCase());
  for (const b of $('formatMenu').querySelectorAll('.opt')) b.setAttribute('aria-selected', String(b.dataset.value === sel.value));
}
const menuOpts = () => [...$('formatMenu').querySelectorAll('.opt')];
function openFormatMenu(focusLast = false) {
  const m = $('formatMenu');
  if (!m.hidden) return;
  m.hidden = false;
  $('formatBtn').setAttribute('aria-expanded', 'true');
  const opts = menuOpts();
  const at = opts.find((b) => b.getAttribute('aria-selected') === 'true') || (focusLast ? opts.at(-1) : opts[0]);
  at?.focus();
  at?.scrollIntoView({ block: 'nearest' });
}
function closeFormatMenu(refocus = true) {
  const m = $('formatMenu');
  if (m.hidden) return;
  m.hidden = true;
  $('formatBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('formatBtn').focus();
}
function pickFormat(v) {
  closeFormatMenu();
  if ($('format').value === v) return;
  $('format').value = v;
  onFormat();
}
$('formatBtn').addEventListener('click', () => ($('formatMenu').hidden ? openFormatMenu() : closeFormatMenu()));
$('formatBtn').addEventListener('keydown', (e) => {
  if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); openFormatMenu(e.key === 'ArrowUp'); }
});
$('formatMenu').addEventListener('click', (e) => { const b = e.target.closest('.opt'); if (b) pickFormat(b.dataset.value); });
$('formatMenu').addEventListener('keydown', (e) => {
  e.stopPropagation(); // the editor's own keys (arrows nudge a crop) stay out of the menu
  const opts = menuOpts(), i = opts.indexOf(document.activeElement);
  const go = (j) => { e.preventDefault(); opts[(j + opts.length) % opts.length]?.focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(opts.length - 1);
  else if (e.key === 'Escape') { e.preventDefault(); closeFormatMenu(); }
  else if (e.key === 'Tab') closeFormatMenu(false);
  else if (e.key.length === 1 && /\w/.test(e.key)) { // type a letter to jump to the first type that starts with it
    const k = e.key.toLowerCase();
    const n = [...opts.slice(i + 1), ...opts.slice(0, i + 1)].find((b) => b.querySelector('.nm').textContent.toLowerCase().startsWith(k));
    if (n) { e.preventDefault(); n.focus(); }
  }
});
addEventListener('pointerdown', (e) => { if (!e.target.closest('.select')) closeFormatMenu(false); });
addEventListener('blur', () => closeFormatMenu(false));
$('ending').addEventListener('input', () => {
  $('ending').classList.toggle('bad', !!typed() && !ENDING.test(typed()));
  $('ext').textContent = `.${ending()}`;
  changed();
});
// A typed ending that's on the menu anyway becomes that choice, so it's converted properly.
$('ending').addEventListener('change', () => {
  const t = typed().toLowerCase();
  if (F?.formats?.includes(t)) { $('ending').value = ''; setFormat(t); }
});
$('ending').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ending').blur(); } });
function placeThumb() {
  const on = $('mode').querySelector(`[data-mode="${mode}"]`), th = $('mode').querySelector('.thumb');
  th.style.left = `${on.offsetLeft}px`; th.style.width = `${on.offsetWidth}px`;
  $('mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === mode));
}
$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  mode = b.dataset.mode;
  placeThumb();
  scrawl.send('tweak:prefs', { copy: mode === 'copy' });
  describeSave();
});
$('stem').addEventListener('input', changed);
$('stem').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('stem').blur(); }
  if (e.key === 'Escape') { e.preventDefault(); $('stem').value = F?.stem ?? ''; changed(); $('stem').blur(); }
});
$('stem').addEventListener('blur', () => commitName());
const LABELS = { png: 'PNG', jpg: 'JPEG', webp: 'WebP', heic: 'HEIC', avif: 'AVIF', tiff: 'TIFF', gif: 'GIF', bmp: 'BMP', ico: 'Icon (ICO)', pdf: 'PDF', icns: 'Mac icon (ICNS)', zip: 'ZIP archive', mp4: 'MP4 video', mov: 'QuickTime movie', m4v: 'M4V video', m4a: 'M4A sound', wav: 'WAV sound', aiff: 'AIFF sound', caf: 'CAF sound', txt: 'Plain text', md: 'Markdown', json: 'JSON', csv: 'CSV', html: 'Web page (HTML)', xml: 'XML', yaml: 'YAML', js: 'JavaScript', css: 'CSS', py: 'Python', rtf: 'Rich text (RTF)', docx: 'Word (DOCX)', odt: 'OpenDocument', doc: 'Word 97 (DOC)' };
function describeSave() {
  if (!F || !K || K.noSave) return;
  const name = `${$('stem').value.trim() || F.stem}.${ending()}`;
  const same = name === F.name;
  const custom = isOther() && ending() !== F.def;
  const note = custom ? (F.kind === 'text' || F.kind === 'rich' ? 'Only the ending is new.' : `Still ${/^[aeiou]/i.test(LABELS[F.def] || F.def) ? 'an' : 'a'} ${(LABELS[F.def] || F.def.toUpperCase()).replace(/ \(.*\)$/, '')} inside; only the ending is new.`) : K?.convert?.(fmt()).note;
  let what;
  if (mode === 'copy') what = `Saves <b></b> beside the original.`;
  else if (same) what = `Saves over <b></b>.${F.prefs.trash ? ' The old version goes to the Trash.' : ''}`;
  else what = `<b></b> takes the place of ${F.name}${F.prefs.trash ? ', which goes to the Trash' : ''}.`;
  $('what').innerHTML = what + (note ? ` ${note}` : '') + (K?.info?.() ? ` <span>${K.info()}</span>` : '');
  $('what').querySelector('b').textContent = mode === 'copy' ? (same ? `${F.stem} copy.${ending()}` : name) : name;
  $('saveText').textContent = mode === 'copy' ? 'Save copy' : custom ? `Save as .${ending()}` : fmt() !== F.own ? `Save as ${(LABELS[fmt()] || fmt().toUpperCase()).replace(/ \(.*\)$/, '').replace(/ (video|sound|movie)$/, '')}` : 'Save';
}
async function save() {
  if (!F || !K || K.noSave || $('save').classList.contains('busy')) return;
  if (isOther() && !ENDING.test(typed())) { toast('Type an ending: letters and numbers, up to 15.', null, true); $('ending').focus(); return; }
  if (!(await commitName())) return;
  const btn = $('save');
  btn.classList.add('busy');
  $('fill').style.width = '8%';
  try {
    // Nothing inside changed and it stays the type it is: no need to build the file again. A new name was
    // already given above, a new ending is a rename, and a copy is a plain (cloned) copy. Instant at any size.
    const inside = K.dirty ? K.dirty() : JSON.stringify(state) !== base;
    if (!inside && fmt() === F.own) {
      const end = ending();
      let r;
      if (mode === 'copy') {
        r = await scrawl.invoke('tweak:copy', { stem: F.stem, ext: end });
        if (r?.ok) toast(`Saved ${r.name} · ${fmtSize(r.size)}`, r.path); else toast(r?.error || 'Couldn’t copy it.', null, true);
      } else if (end !== F.own && end !== F.ext) {
        r = await scrawl.invoke('tweak:rename', { stem: F.stem, ext: end });
        if (r?.ok) { renamed(r); toast(`Saved ${r.name}`, r.path); await start(true); } else toast(r?.error || 'Couldn’t rename it.', null, true);
      } else {
        toast(`Saved ${F.name}`, F.path);
      }
      $('fill').style.width = '100%';
      changed();
      return;
    }
    const job = { ...(await K.job(fmt())), ext: fmt(), stem: F.stem, copy: mode === 'copy' };
    if (isOther()) job.ending = typed();
    const r = await scrawl.invoke('tweak:save', job);
    $('fill').style.width = '100%';
    if (r?.ok) {
      // How big it came out, beside how big it was, so a squeeze shows what it did.
      const was = F.size, sized = r.size != null ? ` · ${fmtSize(r.size)}${was && Math.abs(r.size - was) > was * 0.02 ? ` (was ${fmtSize(was)})` : ''}` : '';
      toast(r.replaced ? `Saved ${r.name}${sized}${r.trashed ? '. The old version is in the Trash.' : ''}` : `Saved ${r.name}${sized}`, r.path);
      if (r.replaced) { await start(true); } // now editing the saved file
    } else toast(r?.error || 'Saving didn’t work.', null, true);
  } catch (err) {
    toast(err.message || 'Saving didn’t work.', null, true);
  } finally {
    setTimeout(() => { btn.classList.remove('busy'); $('fill').style.width = '0'; }, 300);
  }
}
$('save').addEventListener('click', (e) => { e.currentTarget.blur(); save(); });
scrawl.on('tweak:progress', (v) => { $('fill').style.width = `${Math.round(8 + v * 90)}%`; });

// ---------- toast ----------
let toastTimer = 0;
function toast(msg, file = null, err = false) {
  const t = $('toast');
  t.classList.toggle('err', err);
  $('toastIcon').innerHTML = icon(err ? 'warn' : 'check', 2.6);
  $('toastMsg').textContent = msg;
  $('toastBtn').hidden = !file;
  $('toastBtn').onclick = () => scrawl.send('tweak:reveal', file);
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), err ? 6000 : 4200);
}

// ---------- keys ----------
addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 's') { e.preventDefault(); save(); return; }
  if (e.metaKey && e.key === 'ArrowUp' && F?.dir && F.dir !== F.path && !e.target.matches('input, textarea')) { e.preventDefault(); go(F.dir); return; }
  const typing = e.target.matches('input, textarea, select');
  if (e.metaKey && e.key.toLowerCase() === 'z' && !typing && !K?.text) { e.preventDefault(); undo(e.shiftKey ? 'redo' : 'undo'); return; }
  if (e.metaKey && !typing && K?.cmdKeys?.(e)) { e.preventDefault(); return; }
  if (typing || e.metaKey || e.ctrlKey) return;
  if (K?.keys?.(e)) e.preventDefault();
});

// ---------- open, drop ----------
$('open').addEventListener('click', async (e) => { e.currentTarget.blur(); if (!(await commitName())) return; if (await scrawl.invoke('tweak:swap')) start(); });
$('trash').addEventListener('click', async (e) => {
  e.currentTarget.blur();
  if (!F?.path) return;
  const r = await scrawl.invoke('tweak:trash');
  if (r?.canceled) return;
  if (!r?.ok) { toast(r?.error || 'Couldn’t move it to the Trash.', null, true); return; }
  K?.a?.pause?.(); K?.v?.pause?.();
  K = null; state = null; hist.past = []; hist.future = [];
  const name = F.name;
  F = { name, error: true };
  $('chip').textContent = ''; $('dirty').classList.remove('on');
  showProblem('In the Trash', `${name} was moved to the Trash. You can put it back from there.`);
  toast(`Moved ${name} to the Trash`);
});
$('reveal').addEventListener('click', (e) => { e.currentTarget.blur(); if (F) scrawl.send('tweak:reveal', F.path); });
let drag = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { drag++; $('drop').classList.add('on'); } });
addEventListener('dragleave', () => { if (--drag <= 0) { drag = 0; $('drop').classList.remove('on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  drag = 0; $('drop').classList.remove('on');
  const f = e.dataTransfer.files[0];
  const p = f && scrawl.pathFor(f);
  if (p) go(p);
});

// ---------- go ----------
const KINDS = { image: ImageKind, video: VideoKind, audio: AudioKind, text: TextKind, rich: TextKind, dir: DirKind };
// A file Tweak can't edit can still be renamed, given another ending, and looked at.
function aboutFile() {
  const g = group('About it');
  const dl = el('dl', 'facts');
  const rows = [['Kind', F.label], ['Size', fmtSize(F.size)], ['Created', fmtDate(F.ctime)], ['Modified', fmtDate(F.mtime)], ['Where', F.dir]];
  for (const [k, v] of rows) { dl.insertAdjacentHTML('beforeend', `<dt>${k}</dt><dd></dd>`); dl.lastChild.textContent = v || '—'; }
  dl.lastChild.classList.add('where');
  dl.lastChild.addEventListener('click', () => scrawl.send('tweak:reveal', F.path));
  g.append(dl);
  const eg = group('Ending');
  eg.append(el('p', 'note', 'Gives it a different ending. What’s inside stays as it is.'));
  const row = el('div', 'row');
  const inp = el('input', 'txt');
  inp.value = F.ext; inp.placeholder = 'none'; inp.spellcheck = false; inp.maxLength = 15; inp.style.flex = '1';
  const go2 = button('Change', async () => {
    const v = inp.value.trim().replace(/^\.+/, '');
    if (v && !ENDING.test(v)) { toast('An ending is letters and numbers, up to 15.', null, true); return; }
    if (!(await commitName())) return;
    const r = await scrawl.invoke('tweak:rename', { stem: F.stem, ext: v });
    if (r?.ok) { renamed(r); toast(`Renamed to ${r.name}`, r.path); } else toast(r?.error || 'Couldn’t rename it.', null, true);
  }, 'tbtn sm go');
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go2.click(); });
  row.append(inp, go2);
  eg.append(row);
  if (F.kind === 'dir') return;
  let level = 6;
  const cc = compressCard({ estimate: async () => (await scrawl.invoke('tweak:zipEstimate', { level }))?.size ?? null });
  cc.slider({ label: 'Packing', min: 1, max: 9, value: 6, fmt: (v) => (v <= 2 ? 'Quick' : v >= 8 ? 'Smallest' : `Level ${v}`), onInput: (v) => { level = v; cc.soon(); } });
  cc.note('Makes a ZIP of it beside it. The file itself stays as it is.');
  cc.g.append(button('Save ZIP beside it', async () => {
    const r = await scrawl.invoke('tweak:zip', { level });
    if (r?.ok) toast(`Saved ${r.name} · ${fmtSize(r.size)}`, r.path); else toast(r?.error || 'Couldn’t zip it.', null, true);
  }, 'tbtn go'));
  cc.now();
}
function showProblem(title, text) {
  stage.classList.remove('texty');
  stage.innerHTML = `<div class="empty"><div>${Tools.glyph('tweak', 46)}<h2></h2><p></p><button class="tbtn go" id="pick">Open another file</button></div></div>`;
  stage.querySelector('h2').textContent = title;
  stage.querySelector('p').textContent = text;
  $('pick').addEventListener('click', async () => { if (await scrawl.invoke('tweak:swap')) start(); });
  panel.innerHTML = '';
  $('savebar').hidden = true;
  if (F && !F.error && F.path) aboutFile();
}
async function start(keepToast = false) {
  if (!keepToast) $('toast').classList.remove('on');
  K?.a?.pause?.(); K?.v?.pause?.(); K?.stop?.();
  stage.classList.remove('foldery');
  K = null; state = null; hist.past = []; hist.future = [];
  panel.innerHTML = ''; stage.className = 'stage'; stage.innerHTML = '';
  F = await scrawl.invoke('tweak:load');
  if (!F || F.error) { $('stem').value = F?.name || ''; $('chip').textContent = ''; showProblem('Can’t open this file', F?.error || 'Something went wrong.'); return; }
  $('stem').value = F.stem;
  $('ext').textContent = F.ext ? `.${F.ext}` : '';
  $('chip').textContent = [F.label, F.kind === 'dir' ? null : fmtSize(F.size)].filter(Boolean).join(', ');
  document.title = F.name;
  $('ending').value = ''; $('ending').hidden = true;
  if (!F.ok) { showProblem(F.label, F.why); return; }
  if (F.kind === 'dir') {
    $('savebar').hidden = true;
    $('undo').disabled = $('redo').disabled = true;
    K = DirKind;
    try { await K.init(); } catch (err) { K = null; showProblem('Can’t open this folder', err.message); return; }
    changed();
    return;
  }
  $('savebar').hidden = false;
  const sel = $('format');
  sel.innerHTML = '';
  for (const x of F.formats) {
    const o = document.createElement('option');
    o.value = x; o.textContent = `${LABELS[x] || x.toUpperCase()}${x === F.own ? '  (as it is)' : ''}`;
    sel.append(o);
  }
  const other = document.createElement('option');
  other.value = OTHER; other.textContent = 'Other ending…';
  sel.append(document.createElement('hr'), other);
  // A type Pane can read but not write (MP3) starts on the first one it can.
  F.def = F.formats.includes(F.own) ? F.own : F.formats[0];
  sel.value = F.def;
  buildFormatMenu();
  $('ext').textContent = `.${F.def}`;
  mode = F.prefs.copy ? 'copy' : 'replace';
  K = KINDS[F.kind];
  try { await K.init(); } catch (err) { showProblem('Can’t open this file', err.message); K = null; return; }
  base = JSON.stringify(state);
  K.onFormat?.(fmt());
  if (K.text) { $('undo').disabled = false; $('redo').disabled = false; }
  requestAnimationFrame(placeThumb);
  changed();
}
start();

// ---------- window buttons (the editor has no macOS title bar) ----------
document.getElementById('winClose').addEventListener('click', () => scrawl.send('tweak:window', 'close'));
document.getElementById('winHide').addEventListener('click', () => scrawl.send('tweak:window', 'hide'));
addEventListener('blur', () => document.body.classList.add('blurred'));
addEventListener('focus', () => document.body.classList.remove('blurred'));
