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
  return (K.dirty ? K.dirty() : JSON.stringify(state) !== base) || $('stem').value !== F.stem || fmt() !== F.def;
}
function changed() {
  $('dirty').classList.toggle('on', isDirty());
  if (!K?.text) { $('undo').disabled = !hist.past.length; $('redo').disabled = !hist.future.length; }
  describeSave();
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

// ============ pictures ============
const ImageKind = {
  async init() {
    const img = new Image();
    img.src = F.image;
    await img.decode();
    this.img = img;
    this.W0 = img.naturalWidth; this.H0 = img.naturalHeight;
    state = { rot: 0, fh: false, fv: false, crop: null, out: null, adj: { b: 100, c: 100, s: 100, blur: 0, bw: false }, q: 0.9 };
    stage.innerHTML = '<div class="canvas-wrap" id="wrap"><div class="frame checker enter" id="frame"><canvas id="view"></canvas></div></div>';
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
    new ResizeObserver(() => this.draw()).observe($('wrap'));
    this.apply();
  },
  dims() { return state.rot % 180 ? { w: this.H0, h: this.W0 } : { w: this.W0, h: this.H0 }; },
  cropRect() { const { w, h } = this.dims(); return state.crop || { x: 0, y: 0, w, h }; },
  outSize() { const r = this.cropRect(); return state.out || { w: r.w, h: r.h }; },
  filter(k = 1) {
    const a = state.adj;
    return `brightness(${a.b}%) contrast(${a.c}%) saturate(${a.s}%)${a.bw ? ' grayscale(1)' : ''}${a.blur ? ` blur(${(a.blur * k).toFixed(2)}px)` : ''}`;
  },
  // The whole (turned, flipped) picture on a canvas, `k` canvas px per picture px.
  paint(ctx, k) {
    const { w, h } = this.dims();
    ctx.save();
    ctx.translate((w * k) / 2, (h * k) / 2);
    ctx.scale(state.fh ? -1 : 1, state.fv ? -1 : 1);
    ctx.rotate((state.rot * Math.PI) / 180);
    ctx.drawImage(this.img, (-this.W0 * k) / 2, (-this.H0 * k) / 2, this.W0 * k, this.H0 * k);
    ctx.restore();
  },
  draw() {
    const wrap = $('wrap');
    if (!wrap) return;
    const { w, h } = this.dims();
    const k = Math.min((wrap.clientWidth - 68) / w, (wrap.clientHeight - 80) / h, 4);
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const v = this.view, dpr = DPR();
    v.width = cw * dpr; v.height = ch * dpr;
    v.style.width = `${cw}px`; v.style.height = `${ch}px`;
    const ctx = v.getContext('2d');
    ctx.filter = this.filter(k * dpr);
    this.paint(ctx, k * dpr);
    this.k = k;
    this.crop.place(k);
  },
  apply() { this.draw(); this.syncResize(); this.cropUI.sync(); this.adjUI?.(); },
  tools() {
    this.cropUI = cropGroup({
      size: () => this.dims(), live: () => this.crop.isLive(),
      getCrop: () => state.crop, setCrop: (r) => commit({ ...state, crop: r, out: null }),
      onLive: (on) => { this.crop.live(on); this.cropUI.sync(); },
    });
    const turn = group('Turn and flip');
    const row = el('div', 'row fill');
    const turnBy = (d) => {
      const { w: RW, h: RH } = this.dims();
      let c = state.crop;
      // Carry the crop around with the picture.
      if (c) c = d > 0 ? { x: RH - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: RW - (c.x + c.w), w: c.h, h: c.w };
      const out = state.out ? { w: state.out.h, h: state.out.w } : null;
      commit({ ...state, rot: (state.rot + d + 360) % 360, crop: c, out });
    };
    const flip = (axis) => {
      const { w: RW, h: RH } = this.dims();
      let c = state.crop;
      if (c) c = axis === 'h' ? { ...c, x: RW - (c.x + c.w) } : { ...c, y: RH - (c.y + c.h) };
      commit({ ...state, [axis === 'h' ? 'fh' : 'fv']: !state[axis === 'h' ? 'fh' : 'fv'], crop: c });
    };
    row.append(button(icon('left'), () => turnBy(-90), 'tbtn'), button(icon('right'), () => turnBy(90), 'tbtn'),
      button(icon('flipH'), () => flip('h'), 'tbtn'), button(icon('flipV'), () => flip('v'), 'tbtn'));
    [...row.children].forEach((b, i) => b.title = ['Turn left', 'Turn right', 'Flip across', 'Flip upside down'][i]);
    turn.append(row);

    const rs = group('Size', '<button class="link" data-reset>Reset</button>');
    rs.insertAdjacentHTML('beforeend', `<div class="pair"><div class="field"><label for="rw">Width</label><input class="num" id="rw" type="number" min="1" max="20000"></div><button class="lock on" id="rlock" title="Keep the shape">${icon('lock')}</button><div class="field"><label for="rh">Height</label><input class="num" id="rh" type="number" min="1" max="20000"></div></div>`);
    const pct = el('div', 'row fill');
    [25, 50, 75, 100].forEach((p) => pct.append(button(`${p}%`, () => { const r = this.cropRect(); commit({ ...state, out: p === 100 ? null : { w: Math.max(1, Math.round(r.w * p / 100)), h: Math.max(1, Math.round(r.h * p / 100)) } }); }, 'tbtn sm')));
    rs.append(pct);
    const lock = $('rlock');
    lock.addEventListener('click', () => { lock.classList.toggle('on'); lock.innerHTML = icon(lock.classList.contains('on') ? 'lock' : 'unlock'); });
    const sizeFrom = (which) => {
      const r = this.cropRect(), cur = this.outSize();
      let w = Math.round(+$('rw').value) || cur.w, h = Math.round(+$('rh').value) || cur.h;
      if (lock.classList.contains('on')) { if (which === 'w') h = Math.max(1, Math.round(w * r.h / r.w)); else w = Math.max(1, Math.round(h * r.w / r.h)); }
      w = clamp(w, 1, 20000); h = clamp(h, 1, 20000);
      commit({ ...state, out: w === r.w && h === r.h ? null : { w, h } });
    };
    $('rw').addEventListener('change', () => sizeFrom('w'));
    $('rh').addEventListener('change', () => sizeFrom('h'));
    rs.querySelector('[data-reset]').addEventListener('click', () => commit({ ...state, out: null }));

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

    this.qGroup = group('Quality');
    this.q = slider(this.qGroup, { label: 'Smaller file ↔ sharper', min: 40, max: 100, value: 90, unit: '%', onChange: (v) => { state = { ...state, q: v / 100 }; changed(); } });
  },
  syncResize() {
    const o = this.outSize();
    if ($('rw')) { $('rw').value = o.w; $('rh').value = o.h; }
  },
  onFormat(ext) { this.qGroup.hidden = !['jpg', 'webp', 'heic', 'avif'].includes(ext); },
  async job(ext) {
    const r = this.cropRect(), o = this.outSize();
    // Paint the whole picture at full size, then cut and scale the crop out of it.
    const { w, h } = this.dims();
    const full = new OffscreenCanvas(w, h);
    const fctx = full.getContext('2d');
    fctx.filter = this.filter(1);
    this.paint(fctx, 1);
    const out = new OffscreenCanvas(o.w, o.h);
    const ctx = out.getContext('2d');
    const encoded = ext === 'jpg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
    if (encoded === 'jpeg' || ['bmp', 'pdf'].includes(ext)) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, o.w, o.h); } // no see-through in these
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, r.x, r.y, r.w, r.h, 0, 0, o.w, o.h);
    const blob = await out.convertToBlob({ type: `image/${encoded}`, quality: state.q });
    return { kind: 'image', bytes: await blob.arrayBuffer(), encoded, quality: state.q };
  },
  info() { const o = this.outSize(); return `${o.w} × ${o.h}`; },
  keys(e) { if (e.key === 'Escape' && this.crop.isLive()) { this.crop.live(false); this.cropUI.sync(); return true; } if (e.key === 'Enter' && this.crop.isLive()) { this.crop.live(false); this.cropUI.sync(); return true; } return false; },
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
  function place() {
    const { start, end } = getRange();
    $('trimL').style.left = pos(start); $('trimR').style.left = pos(end);
    $('outL').style.width = pos(start); $('outR').style.width = `${(1 - end / D()) * 100}%`;
    $('head').style.left = pos(media.currentTime);
    $('clock').innerHTML = `<b>${fmtTime(media.currentTime)}</b> / ${fmtTime(end - start)}`;
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
        media.currentTime = side === 'L' ? getRange().start : getRange().end;
        place();
      };
      const up = () => { h.removeEventListener('pointermove', move); end?.(); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
    });
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('trim')) return;
    track.setPointerCapture(e.pointerId);
    const go = (ev) => { media.currentTime = at(ev); place(); onSeek?.(); };
    go(e);
    track.addEventListener('pointermove', go);
    track.addEventListener('pointerup', () => track.removeEventListener('pointermove', go), { once: true });
  });
  const play = () => {
    const { start, end } = getRange();
    if (media.paused) { if (media.currentTime < start || media.currentTime >= end - 0.05) media.currentTime = start; media.play(); } else media.pause();
  };
  $('play').addEventListener('click', (e) => { e.currentTarget.blur(); play(); });
  media.addEventListener('play', () => { $('play').innerHTML = icon('pause'); loop(); });
  media.addEventListener('pause', () => { $('play').innerHTML = icon('play'); });
  // While playing: stay inside the trimmed part, looping back to its start.
  function loop() {
    if (media.paused) return;
    const { start, end } = getRange();
    if (media.currentTime >= end) media.currentTime = start;
    place();
    requestAnimationFrame(loop);
  }
  media.addEventListener('seeked', place);
  return { place, play, strip: $('strip') };
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

// ============ video ============
const VideoKind = {
  async init() {
    stage.innerHTML = '<div class="canvas-wrap" id="wrap"><div class="frame enter" id="frame"><video id="video" preload="auto" playsinline></video></div></div>';
    const v = $('video');
    v.src = F.url;
    this.v = v;
    await waitMeta(v);
    this.W = v.videoWidth; this.H = v.videoHeight;
    state = { start: 0, end: v.duration, crop: null, rot: 0, fh: false, fv: false, vol: 1, mute: false, gifFps: 12, gifWidth: 480 };
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
    if (!wrap) return;
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
    this.trim.sync(); this.cropUI.sync(); this.soundUI?.();
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
  onFormat(ext) { this.gif.hidden = ext !== 'gif'; },
  async job() {
    return { kind: 'media', ops: { start: state.start, end: state.end, crop: state.crop ? [state.crop.x, state.crop.y, state.crop.w, state.crop.h] : null, rotate: state.rot, flipH: state.fh, flipV: state.fv, volume: state.vol, mute: state.mute, gifFps: state.gifFps, gifWidth: state.gifWidth } };
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
    state = { start: 0, end: a.duration, vol: 1 };
    let pre = null;
    const range = () => ({ start: state.start, end: state.end });
    this.tl = timeline(stage, a, {
      getRange: range, setRange: (r) => { state = { ...state, ...r }; this.drawWave(); },
      begin: () => { pre = JSON.stringify(state); }, end: () => { if (pre !== JSON.stringify(state)) { hist.past.push(pre); hist.future = []; changed(); this.trim.sync(); } },
    });
    this.trim = trimGroup(a, { getRange: range, commitRange: (r) => commit({ ...state, ...r }), tl: this.tl });
    const snd = group('Volume');
    let p2 = null;
    this.vol = slider(snd, { label: 'Quieter', min: 0, max: 100, value: 100, unit: '%', onInput: (x) => { p2 ??= JSON.stringify(state); state = { ...state, vol: x / 100 }; a.volume = state.vol; this.drawWave(); }, onChange: () => { if (p2 !== JSON.stringify(state)) { hist.past.push(p2); hist.future = []; changed(); } p2 = null; } });
    snd.append(el('p', 'note', 'Turns the whole file down. 100% leaves it as it is.'));
    a.addEventListener('timeupdate', () => this.drawWave());
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
    if (!c) return;
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
      ctx.fillStyle = !inside ? 'rgba(255,255,255,0.14)' : t <= this.a.currentTime ? '#CDEB5A' : 'rgba(205,235,90,0.42)';
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
  apply() { this.a.volume = state.vol; this.vol.set(Math.round(state.vol * 100)); this.trim.sync(); this.drawWave(); },
  async job() { return { kind: 'media', ops: { start: state.start, end: state.end, volume: state.vol } }; },
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
    if (['md', 'markdown'].includes(from) && ext === 'html') return { text: pageFor(markdown(v), F.stem), note: 'The Markdown becomes a web page.' };
    if (['csv', 'tsv'].includes(from) && ext === 'json') { const rows = parseCSV(v, from === 'tsv' ? '\t' : ','); return { text: `${JSON.stringify(rows, null, 2)}\n`, note: `Each row becomes a JSON object (${rows.length} rows).` }; }
    if (from === 'json' && ext === 'csv') {
      try { const d = JSON.parse(v); const list = Array.isArray(d) ? d.filter((x) => x && typeof x === 'object') : [d]; if (list.length) return { text: toCSV(list), note: `Each object becomes a row (${list.length} rows).` }; } catch {}
    }
    return { text: v, note: null };
  },
  async job(ext) { return { kind: 'text', text: this.convert(ext).text }; },
  info() { return null; },
  keys() { return false; },
};

// ---------- save bar ----------
const fmt = () => $('format').value;
let mode = 'replace';
function setFormat(ext) { $('format').value = ext; onFormat(); }
function onFormat() { K?.onFormat?.(fmt()); $('ext').textContent = `.${fmt()}`; changed(); }
$('format').addEventListener('change', onFormat);
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
$('stem').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('stem').blur(); } });
const LABELS = { png: 'PNG', jpg: 'JPEG', webp: 'WebP', heic: 'HEIC', avif: 'AVIF', tiff: 'TIFF', gif: 'GIF', bmp: 'BMP', ico: 'Icon (ICO)', pdf: 'PDF', mp4: 'MP4 video', mov: 'QuickTime movie', m4v: 'M4V video', m4a: 'M4A sound', wav: 'WAV sound', aiff: 'AIFF sound', caf: 'CAF sound', txt: 'Plain text', md: 'Markdown', json: 'JSON', csv: 'CSV', html: 'Web page (HTML)', xml: 'XML', yaml: 'YAML', js: 'JavaScript', css: 'CSS', py: 'Python', rtf: 'Rich text (RTF)', docx: 'Word (DOCX)', odt: 'OpenDocument', doc: 'Word 97 (DOC)' };
function describeSave() {
  if (!F) return;
  const name = `${$('stem').value.trim() || F.stem}.${fmt()}`;
  const same = name === F.name;
  const note = K?.convert?.(fmt()).note;
  let what;
  if (mode === 'copy') what = `Saves <b></b> beside the original.`;
  else if (same) what = `Saves over <b></b>.${F.prefs.trash ? ' The old version goes to the Trash.' : ''}`;
  else what = `<b></b> takes the place of ${F.name}${F.prefs.trash ? ', which goes to the Trash' : ''}.`;
  $('what').innerHTML = what + (note ? ` ${note}` : '') + (K?.info?.() ? ` <span>${K.info()}</span>` : '');
  $('what').querySelector('b').textContent = mode === 'copy' ? (same ? `${F.stem} copy.${fmt()}` : name) : name;
  $('saveText').textContent = mode === 'copy' ? 'Save copy' : fmt() !== F.own ? `Save as ${(LABELS[fmt()] || fmt().toUpperCase()).replace(/ \(.*\)$/, '').replace(/ (video|sound|movie)$/, '')}` : 'Save';
}
async function save() {
  if (!F || !K || $('save').classList.contains('busy')) return;
  const btn = $('save');
  btn.classList.add('busy');
  $('fill').style.width = '8%';
  try {
    const job = { ...(await K.job(fmt())), ext: fmt(), stem: $('stem').value.trim() || F.stem, copy: mode === 'copy' };
    const r = await scrawl.invoke('tweak:save', job);
    $('fill').style.width = '100%';
    if (r?.ok) {
      toast(r.replaced ? `Saved ${r.name}${r.trashed ? '. The old version is in the Trash.' : ''}` : `Saved ${r.name}`, r.path);
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
  const typing = e.target.matches('input, textarea, select');
  if (e.metaKey && e.key.toLowerCase() === 'z' && !typing && !K?.text) { e.preventDefault(); undo(e.shiftKey ? 'redo' : 'undo'); return; }
  if (typing || e.metaKey || e.ctrlKey) return;
  if (K?.keys?.(e)) e.preventDefault();
});

// ---------- open, drop ----------
$('open').addEventListener('click', async (e) => { e.currentTarget.blur(); if (await scrawl.invoke('tweak:swap')) start(); });
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
  if (p && await scrawl.invoke('tweak:swap', p)) start();
});

// ---------- go ----------
const KINDS = { image: ImageKind, video: VideoKind, audio: AudioKind, text: TextKind, rich: TextKind };
function showProblem(title, text) {
  stage.classList.remove('texty');
  stage.innerHTML = `<div class="empty"><div>${Tools.glyph('tweak', 46)}<h2></h2><p></p><button class="tbtn go" id="pick">Open another file</button></div></div>`;
  stage.querySelector('h2').textContent = title;
  stage.querySelector('p').textContent = text;
  $('pick').addEventListener('click', async () => { if (await scrawl.invoke('tweak:swap')) start(); });
  panel.innerHTML = '';
  $('savebar').hidden = true;
}
async function start(keepToast = false) {
  if (!keepToast) $('toast').classList.remove('on');
  K?.a?.pause?.(); K?.v?.pause?.();
  K = null; state = null; hist.past = []; hist.future = [];
  panel.innerHTML = ''; stage.className = 'stage'; stage.innerHTML = '';
  F = await scrawl.invoke('tweak:load');
  if (!F || F.error) { $('stem').value = F?.name || ''; $('chip').textContent = ''; showProblem('Can’t open this file', F?.error || 'Something went wrong.'); return; }
  $('stem').value = F.stem;
  $('ext').textContent = F.ext ? `.${F.ext}` : '';
  $('chip').textContent = [F.label, fmtSize(F.size)].filter(Boolean).join(', ');
  document.title = F.name;
  if (!F.ok) { showProblem(F.label, F.why); return; }
  $('savebar').hidden = false;
  const sel = $('format');
  sel.innerHTML = '';
  for (const x of F.formats) {
    const o = document.createElement('option');
    o.value = x; o.textContent = `${LABELS[x] || x.toUpperCase()}${x === F.own ? '  (as it is)' : ''}`;
    sel.append(o);
  }
  // A type Pane can read but not write (MP3) starts on the first one it can.
  F.def = F.formats.includes(F.own) ? F.own : F.formats[0];
  sel.value = F.def;
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
