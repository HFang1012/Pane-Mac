const $ = (id) => document.getElementById(id);
const BOUNCY = getComputedStyle(document.documentElement).getPropertyValue('--bouncy').trim();
const COLORS = Wheel.COLORS; // shared with the wheel's color ring

let S = null;
let status = { trusted: false, listening: false };

async function save(patch) {
  S = await scrawl.invoke('settings:set', patch);
  update();
}

// ---------- held keys: Scrawl's wheel key and draw key, Spin's key, and the double-tap keys ----------
// (Shortcuts like ⌃⌘A are chosen by shortcutWell, below; their wells have no data-which.)
const wells = [...document.querySelectorAll('.keywell[data-which]')];
const wellFor = (which) => wells.find((w) => w.dataset.which === which);
const KEY_NAMES = { hotkey: 'Wheel key', drawKey: 'Draw key', spinKey: 'Spin key', jotKey: 'Jot key', tweakKey: 'Tweak key', awayKey: 'Away key', debugKey: 'Debug key' };
const DEFAULT_CAPTION = 'Click a key to change it. Hold several to use them together.';
const JOT_CAPTION = 'Click the key to change it. Tap it twice, quickly.';
const TAP_HOLD_CAPTION = 'Click the key to change it. Tap it, then tap again and hold.';
let listening = null; // which key is being chosen
const OWN_KEY = { spinKey: 'spin', jotKey: 'jot', tweakKey: 'tweak', awayKey: 'away', debugKey: 'debug' };
const keyOf = (which) => (OWN_KEY[which] ? S[OWN_KEY[which]]?.key : S[which]);
const TWEAK_CAPTION = JOT_CAPTION;
// Keys that are tapped rather than held take one modifier (the main process says the same).
const tapped = (which) => ['jotKey', 'tweakKey', 'awayKey', 'debugKey'].includes(which) ||
  (which === 'hotkey' && S?.wheelMode === 'double') || (which === 'spinKey' && S?.spin?.mode === 'double');
// Each page's caption, as it reads when nothing is being chosen. Pages set to a shortcut leave theirs to it.
const CAPTIONS = {
  hotkey: () => (S?.wheelMode === 'double' ? 'Click a key to change it. Tap the wheel key, then tap again and hold.' : DEFAULT_CAPTION),
  spinKey: () => (S?.spin?.mode === 'double' ? TAP_HOLD_CAPTION : DEFAULT_CAPTION),
  jotKey: () => (S?.jot?.mode === 'shortcut' ? null : JOT_CAPTION),
  tweakKey: () => (S?.tweak?.mode === 'shortcut' ? null : TWEAK_CAPTION),
  awayKey: () => (S?.away?.mode === 'double' ? JOT_CAPTION : null),
  debugKey: () => (S?.debug?.mode === 'shortcut' ? null : S?.debug?.mode === 'hold' ? 'Click the key to change it. Hold it down for a moment.' : JOT_CAPTION),
};

// One keycap per key in the combo. A key that counts on one side only (Spin's right ⌘) says which side.
function keycaps(keys, { pop = false, held = false } = {}) {
  return keys.map((k, i) => {
    const word = k.symbol.length > 1;
    const side = k.side ? `<small class="side">${k.side}</small>` : '';
    return `<span class="keycap${word ? ' word' : ''}${k.side ? ' sided' : ''}${pop ? ' pop' : ''}${held ? ' held-key' : ''}" style="--d:${i * 50}ms" aria-hidden="true">${k.symbol}${side}</span>`;
  }).join('');
}
const keysOf = (k) => (k?.keys?.length ? k.keys : k ? [k] : []);
// "left ⌥", "left ⌃ + right ⌘": for status lines.
const keyText = (k) => keysOf(k).map((x) => `${x.side ? `${x.side} ` : ''}${x.symbol}`).join(' + ');
function renderKey(which, pop) {
  const k = keyOf(which);
  const well = wellFor(which);
  if (!k || !well) return;
  well.querySelector('.keys').innerHTML = keycaps(keysOf(k), { pop });
  well.setAttribute('aria-label', `${KEY_NAMES[which]}: ${k.name}. Click to change.`);
}
// While choosing: the keys you're holding appear as you press them.
scrawl.on('bind:progress', ({ which, keys }) => {
  const well = wellFor(which);
  if (!well || listening !== which) return;
  well.querySelector('.keys').innerHTML = keycaps(keys, { pop: true, held: true });
  setCaption(keys.length > 1 ? 'Let go to use these keys together.' : 'Add more keys, or let go to use this one.', false, which);
});
const captionFor = (which) => $({ spinKey: 'spinCaption', jotKey: 'jotCaption', tweakKey: 'tweakCaption', awayKey: 'awayCaption', debugKey: 'debugCaption' }[which] || 'keycaption');
function setCaption(text, warn = false, which = listening) {
  const c = captionFor(which);
  c.textContent = text;
  c.classList.toggle('warn', warn);
}
for (const well of wells) {
  well.addEventListener('click', async () => {
    well.blur(); // the next key press shouldn't paint a focus ring on the button
    const which = well.dataset.which;
    cancelShortcuts();
    if (listening) {
      const was = listening;
      stopListening();
      scrawl.send('bind:cancel');
      if (was === which) return;
    }
    const ok = await scrawl.invoke('bind:start', which);
    if (!ok) {
      setCaption('Allow Accessibility access first.', true, which);
      const ask = well.closest('.page').querySelector('.access'); // the ask on this tool's own page
      ask.classList.add('open');
      shake(ask);
      return;
    }
    listening = which;
    well.classList.add('listening');
    well.querySelector('.keys').innerHTML = '<span class="prompt pop">Hold keys</span>';
    setCaption(tapped(which) ? 'Press ⌃, ⌥, ⇧ or ⌘. Esc cancels.' : 'Hold one key, or a few together. Esc cancels.', false, which);
  });
}
function stopListening(popWhich = null) {
  for (const w of wells) w.classList.remove('listening');
  listening = null;
  for (const which of Object.keys(KEY_NAMES)) renderKey(which, popWhich === which);
  resetCaptions();
}
function resetCaptions() {
  for (const [which, text] of Object.entries(CAPTIONS)) { const t = text(); if (t) setCaption(t, false, which); }
}
// A tool switched to a way whose keys another tool was using: its keys moved, and its caption says where.
scrawl.on('keys:moved', (list) => {
  for (const [caption, line] of list) { const c = $(caption); if (c) { c.textContent = line; c.classList.add('warn'); } }
});
scrawl.on('bind:done', ({ settings, which, error }) => {
  S = settings;
  stopListening(error ? null : which);
  if (error) { setCaption(error, true, which); shake(wellFor(which)); }
  updateStatus();
});

// ---------- shortcuts: keys pressed together, like ⌃⌘A (Away's, Jot's, Tweak's), chosen by pressing them ----------
const MOD_ORDER = [ // macOS writes modifiers in this order
  { prop: 'ctrlKey', acc: 'Control', sym: '⌃', name: 'Control' },
  { prop: 'altKey', acc: 'Alt', sym: '⌥', name: 'Option' },
  { prop: 'shiftKey', acc: 'Shift', sym: '⇧', name: 'Shift' },
  { prop: 'metaKey', acc: 'Command', sym: '⌘', name: 'Command' },
];
const NAMED = {
  Space: ['Space', '␣'], Enter: ['Return', '↩'], Tab: ['Tab', '⇥'], Backspace: ['Backspace', '⌫'], Delete: ['Delete', '⌦'],
  Escape: ['Escape', '⎋'], ArrowUp: ['Up', '↑'], ArrowDown: ['Down', '↓'], ArrowLeft: ['Left', '←'], ArrowRight: ['Right', '→'],
  Minus: ['-', '-'], Equal: ['=', '='], BracketLeft: ['[', '['], BracketRight: [']', ']'], Semicolon: [';', ';'], Quote: ["'", "'"],
  Comma: [',', ','], Period: ['.', '.'], Slash: ['/', '/'], Backslash: ['\\', '\\'], Backquote: ['`', '`'],
};
// The key itself, from its position on the keyboard (so ⌥ turning A into å doesn't matter).
function mainKey(code) {
  let m = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
  if (m) return [m[1], m[1]];
  if (/^F\d{1,2}$/.test(code)) return [code, code];
  return NAMED[code] || null;
}
const held = (e) => MOD_ORDER.filter((m) => e[m.prop]);

const shortcutWells = [];
const cancelShortcuts = () => shortcutWells.forEach((w) => w.cancel());
// One well per tool. `idle` is the caption when nothing is being chosen; `done` runs after new keys are saved.
function shortcutWell({ tool, well, caption, label, idle = () => 'Click the keys to change them.', done = () => {} }) {
  let on = false;
  const setCap = (text, warn = false) => { const c = $(caption); c.textContent = text; c.classList.toggle('warn', warn); };
  function render(symbols, { pop = false, partial = false } = {}) {
    well.querySelector('.keys').innerHTML = symbols.map((s, i) =>
      `<span class="keycap${s.length > 1 ? ' word' : ''}${pop ? ' pop' : ''}${partial ? ' held' : ''}" style="--d:${i * 50}ms" aria-hidden="true">${s}</span>`).join('');
    well.setAttribute('aria-label', `${label}: ${S[tool].keys.name}. Click to change.`);
  }
  function cancel() {
    if (!on) return;
    on = false;
    well.classList.remove('listening');
    scrawl.send('shortcut:bind', tool, false);
    render(S[tool].keys.symbols);
    setCap(idle());
  }
  well.addEventListener('click', () => {
    well.blur();
    if (on) { cancel(); return; }
    if (listening) { stopListening(); scrawl.send('bind:cancel'); }
    cancelShortcuts();
    on = true;
    well.classList.add('listening');
    scrawl.send('shortcut:bind', tool, true);
    well.querySelector('.keys').innerHTML = '<span class="prompt pop">Press keys</span>';
    setCap('Hold ⌘, ⌃ or ⌥ and press a key.');
  });
  addEventListener('keydown', async (e) => {
    if (!on) return;
    e.preventDefault();
    e.stopPropagation();
    const mods = held(e);
    if (e.code === 'Escape' && !mods.length) { cancel(); return; }
    const key = mainKey(e.code);
    if (!key) { // only modifiers so far: show them as they're held
      if (mods.length) render(mods.map((m) => m.sym), { partial: true });
      return;
    }
    if (!mods.some((m) => m.prop !== 'shiftKey')) { setCap('Add ⌘, ⌃ or ⌥ too.', true); shake(well); return; }
    const keys = {
      accelerator: [...mods.map((m) => m.acc), key[0]].join('+'),
      symbols: [...mods.map((m) => m.sym), key[1]],
      name: [...mods.map((m) => m.name), key[0]].join(' '),
    };
    on = false;
    well.classList.remove('listening');
    const { settings, error } = await scrawl.invoke('shortcut:keys', tool, keys);
    S = settings;
    render(S[tool].keys.symbols, { pop: !error });
    if (error) { setCap(error, true); shake(well); } else setCap(idle());
    done();
    pollStatus();
  }, true);
  addEventListener('keyup', (e) => {
    if (!on) return;
    const mods = held(e);
    well.querySelector('.keys').innerHTML = mods.length
      ? mods.map((m) => `<span class="keycap held" aria-hidden="true">${m.sym}</span>`).join('')
      : '<span class="prompt">Press keys</span>';
  });
  addEventListener('blur', cancel);
  const api = { cancel, render, get listening() { return on; } };
  shortcutWells.push(api);
  return api;
}

// ---------- how a tool opens: two ways, side by side (hold or double-tap, a shortcut or double-tap) ----------
// `get` reads the mode, `set` saves a new one. The key slots below it show or hide by their data-mode.
const segs = [];
function placeSeg(seg, mode, animate = true) {
  const on = seg.querySelector(`[data-mode="${mode}"]`);
  const thumb = seg.querySelector('.seg-thumb');
  if (!on || !on.offsetWidth) return; // the page is hidden: placed when it shows
  if (!animate) thumb.style.transition = 'none';
  thumb.style.translate = `${on.offsetLeft - 4}px 0`;
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.left = '4px';
  if (!animate) requestAnimationFrame(() => { thumb.style.transition = ''; });
}
function modeSeg(seg, get, set) {
  const s = { seg, get, placed: false };
  segs.push(s);
  new ResizeObserver(() => { if (S) placeSeg(seg, get(), false); }).observe(seg);
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === get()) return;
    b.blur();
    cancelShortcuts();
    if (listening) { stopListening(); scrawl.send('bind:cancel'); }
    set(b.dataset.mode).then(() => {
      resetCaptions();
      const row = seg.parentElement.querySelector(`.keyrow[data-for="${seg.id}"]`);
      for (const slot of row?.querySelectorAll('.keyslot:not([hidden])') || []) {
        slot.classList.remove('swap-in'); void slot.offsetWidth; slot.classList.add('swap-in');
      }
      pollStatus();
    });
  });
}
function renderSegs() {
  for (const s of segs) {
    const mode = s.get();
    placeSeg(s.seg, mode, s.placed);
    s.placed ||= !!s.seg.offsetWidth;
    for (const b of s.seg.querySelectorAll('button')) b.setAttribute('aria-checked', b.dataset.mode === mode);
    const row = s.seg.parentElement.querySelector(`.keyrow[data-for="${s.seg.id}"]`);
    for (const slot of row?.querySelectorAll('.keyslot[data-mode]') || []) slot.hidden = !slot.dataset.mode.split(' ').includes(mode);
  }
}
modeSeg($('wheelMode'), () => S.wheelMode, (mode) => save({ wheelMode: mode }));

function shake(el) {
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' },
    { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 360, easing: 'ease-out' });
}

// ---------- wheel preview ----------
// When the order changes, each slice swings around the circle from its old spot to its new one.
let previewItems = null;
let previewHot = null;
function onItems(ids = S.tools.map((t) => t.id)) {
  return ids.filter((id) => S.tools.find((t) => t.id === id)?.on);
}
function renderPreview(items = onItems()) {
  const old = previewItems;
  if (!old || old.join() !== items.join()) {
    previewItems = items;
    $('preview').innerHTML = Wheel.build({ items, size: 40, enter: !old });
    const svg = $('preview').querySelector('svg');
    if (old) {
      const deg = (r) => (r * 180) / Math.PI;
      const newMid = Object.fromEntries(Wheel.layout(items).map((x) => [x.id, deg(x.mid)]));
      const oldMid = Object.fromEntries(Wheel.layout(old).map((x) => [x.id, deg(x.mid)]));
      svg.querySelectorAll('.slice').forEach((g) => {
        const id = g.dataset.id, oi = old.indexOf(id);
        if (oi < 0) {
          g.animate([{ transform: 'scale(0.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 460, easing: BOUNCY });
          return;
        }
        let delta = oldMid[id] - newMid[id];
        delta = ((delta + 540) % 360) - 180; // the short way round
        if (Math.abs(delta) < 0.5) return;
        g.animate([{ transform: `rotate(${delta}deg)` }, { transform: 'none' }], { duration: 560, easing: BOUNCY });
        // Counter-rotate the icon so it stays upright while its slice travels.
        g.querySelector('.ico').animate([{ transform: `rotate(${-delta}deg)` }, { transform: 'none' }], { duration: 560, easing: BOUNCY });
      });
      if (old.length !== items.length) {
        svg.querySelector('.wheel-body').animate([{ transform: 'scale(0.9)' }, { transform: 'none' }], { duration: 460, easing: BOUNCY });
      }
    }
  }
  hoverPreview(previewHot);
}
function hoverPreview(id) {
  previewHot = id;
  const svg = $('preview').querySelector('svg');
  if (svg) Wheel.setHover(svg, id ? previewItems.indexOf(id) : null, previewItems, true);
}

// ---------- tool tiles ----------
const tilesEl = $('tiles');
const tileEls = new Map();
let drag = null; // { id, el, startX, startY, grabX, moved, order }

function toggleTool(id, el) {
  const t = S.tools.find((x) => x.id === id);
  if (t.on && onItems().length === 1) {
    el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope');
    flashHint('The wheel needs at least one tool.');
    return;
  }
  save({ tools: S.tools.map((x) => (x.id === id ? { ...x, on: !x.on } : x)) });
}

// Slot positions come from layout widths (never from where tiles are mid-animation), and tiles can be
// full or half width. For the dragged tile we try every slot and keep the one nearest the pointer.
const GAP = 6; // matches .tiles gap
function slotLeft(order, id) {
  let x = tilesEl.getBoundingClientRect().left;
  for (const i of order) { if (i === id) return x; x += tileEls.get(i).offsetWidth + GAP; }
  return x;
}
function nearestSlot(order, id, wantLeft) {
  const others = order.filter((i) => i !== id);
  let best = 0, bestD = Infinity;
  for (let k = 0; k <= others.length; k++) {
    const seq = [...others.slice(0, k), id, ...others.slice(k)];
    const d = Math.abs(slotLeft(seq, id) - wantLeft);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

function makeTile(id, i) {
  const info = Wheel.TOOLS[id];
  const el = document.createElement('div');
  el.className = `tile pop${info.half ? ' half' : ''}`;
  el.style.setProperty('--d', `${200 + i * 50}ms`);
  el.tabIndex = 0;
  el.setAttribute('role', 'switch');
  el.innerHTML = `<span class="glyph">${Wheel.glyph(id, info.half ? 34 : 44)}</span><span class="name">${info.name}</span>
    <span class="check" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" fill="none" stroke="#FBF8F3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleTool(id, el); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const ids = S.tools.map((t) => t.id);
      const from = ids.indexOf(id), to = from + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      saveOrder(ids).then(() => el.focus());
    }
  });
  el.addEventListener('mouseenter', () => { if (!drag) hoverPreview(S.tools.find((t) => t.id === id)?.on ? id : null); });
  el.addEventListener('mouseleave', () => { if (!drag) hoverPreview(null); });

  // Press and drag to reorder; a press without movement toggles the tool.
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const r = el.getBoundingClientRect();
    drag = { id, el, startX: e.clientX, startY: e.clientY, grabX: e.clientX - r.left, moved: false, order: S.tools.map((t) => t.id) };
    // Capture on the row, which never moves, so a release outside the window still ends the drag.
    try { tilesEl.setPointerCapture(e.pointerId); } catch {}
  });
  return el;
}

// Drag tracking lives on the window: re-slotting the tile moves its DOM node, which would drop element-level capture.
addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { id, el } = drag;
  const dy = e.clientY - drag.startY;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startX, dy) < 5) return;
    drag.moved = true;
    el.classList.add('dragging');
    hoverPreview(S.tools.find((t) => t.id === id).on ? id : null);
  }
  const x = e.clientX - drag.grabX; // where the tile's left edge wants to be
  const idx = nearestSlot(drag.order, id, x);
  if (idx !== drag.order.indexOf(id)) {
    drag.order.splice(idx, 0, drag.order.splice(drag.order.indexOf(id), 1)[0]);
    arrange(drag.order, id);
    renderPreview(onItems(drag.order));
  }
  el.style.translate = `${x - slotLeft(drag.order, id)}px ${dy * 0.3}px`;
});
function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  for (const t of tileEls.values()) if (t !== d.el) t.classList.remove('dragging');
  // With the row capturing the pointer, the release target is the row: hit-test the tile under the pointer instead.
  const under = e.clientX != null ? document.elementFromPoint(e.clientX, e.clientY) : null;
  if (!d.moved) { if (e.type === 'pointerup' && d.el.contains(under)) toggleTool(d.id, d.el); return; }
  // Spring from wherever it was dropped into its slot.
  const from = d.el.style.translate || '0px 0px';
  d.el.style.translate = '';
  d.el.classList.remove('dragging');
  d.el.animate([{ translate: from }, { translate: '0px 0px' }], { duration: 480, easing: BOUNCY });
  hoverPreview(null);
  if (d.order.join() !== S.tools.map((t) => t.id).join()) saveOrder(d.order);
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);
addEventListener('blur', () => endDrag({ type: 'blur' }));
function saveOrder(ids) {
  return save({ tools: ids.map((id) => S.tools.find((t) => t.id === id)) });
}

// FLIP: note where every tile is on screen, move the nodes, then slide each from there to its new slot.
function arrange(ids, skip = null) {
  const before = new Map([...tileEls].map(([id, el]) => [id, el.getBoundingClientRect().left]));
  for (const el of tileEls.values()) if (el !== tileEls.get(skip)) el.getAnimations().forEach((a) => a.cancel());
  ids.forEach((id) => tilesEl.appendChild(tileEls.get(id)));
  for (const [id, el] of tileEls) {
    if (id === skip) continue;
    const dx = before.get(id) - el.getBoundingClientRect().left;
    if (Math.abs(dx) > 1) el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: 440, easing: BOUNCY });
  }
}
function renderTiles() {
  S.tools.forEach((t, i) => {
    if (!tileEls.has(t.id)) {
      const el = makeTile(t.id, i);
      tileEls.set(t.id, el);
      tilesEl.appendChild(el);
    }
    const el = tileEls.get(t.id);
    el.classList.toggle('on', t.on);
    el.setAttribute('aria-checked', t.on);
    el.setAttribute('aria-label', `${Wheel.TOOLS[t.id].name}: ${t.on ? 'on' : 'off'} the wheel, position ${i + 1}. Arrow keys move it.`);
  });
  const current = [...tilesEl.children].map((el) => [...tileEls].find(([, x]) => x === el)[0]);
  const wanted = S.tools.map((t) => t.id);
  if (!drag && current.join() !== wanted.join()) arrange(wanted);
}
let hintTimer;
function flashHint(text) {
  const p = $('toolsHint');
  p.textContent = text;
  p.style.color = 'var(--accent-ink)';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    p.textContent = 'Click to remove a tool. Drag to reorder.';
    p.style.color = '';
  }, 2200);
}

// ---------- swatches ----------
function renderSwatches() {
  const box = $('swatches');
  if (!box.children.length) {
    COLORS.forEach(({ hex, lip, name }, i) => {
      const b = document.createElement('button');
      b.className = 'swatch pop';
      b.style.setProperty('--c', hex);
      b.style.setProperty('--lipc', lip);
      b.style.setProperty('--d', `${320 + i * 35}ms`);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', name);
      b.dataset.hex = hex;
      b.addEventListener('animationend', () => b.classList.remove('pop'), { once: true });
      b.addEventListener('click', () => save({ pencilColor: hex }));
      box.appendChild(b);
    });
  }
  for (const b of box.children) b.setAttribute('aria-checked', b.dataset.hex === S.pencilColor.toUpperCase());
}

// ---------- steppers ----------
function stepperText(el, v) {
  const values = el.dataset.values.split(',').map(Number);
  const labels = el.dataset.labels?.split(',');
  const i = values.indexOf(v);
  return labels ? labels[i] : `${v}${el.dataset.unit || ''}`;
}
// A stepper's key can reach into a tool's own settings: "spin.count" is S.spin.count.
const getKey = (key) => key.split('.').reduce((o, k) => o?.[k], S);
function patchFor(key, v) {
  const [a, b] = key.split('.');
  return b ? { [a]: { ...S[a], [b]: v } } : { [a]: v };
}
// Each stepper keeps the value it shows (`el._v`). Saves are async, so `S` lags behind fast clicks;
// stepping from `S` would repeat the same value and pile up labels.
// A stepper with `data-free="min,max"` also takes any typed whole number in that range; its buttons then
// step to the nearest preset above or below.
const isFree = (el) => 'free' in el.dataset;
const presets = (el) => el.dataset.values.split(',').map(Number);
// The preset one step from `v` in `dir`, or undefined at the end of the list.
function neighbor(el, v, dir) {
  const values = presets(el);
  const i = values.indexOf(v);
  if (i !== -1) return values[i + dir];
  if (!isFree(el)) return values[Math.max(0, i + dir)];
  return dir > 0 ? values.find((x) => x > v) : [...values].reverse().find((x) => x < v);
}
const shown = (el, v) => (isFree(el) || presets(el).includes(v) ? v : presets(el)[0]);
function setButtons(el) {
  const [dec, inc] = el.querySelectorAll('button');
  dec.disabled = neighbor(el, el._v, -1) === undefined;
  inc.disabled = neighbor(el, el._v, 1) === undefined;
}
function renderSteppers() {
  document.querySelectorAll('.stepper').forEach((el) => {
    const key = el.dataset.key;
    // Nothing in flight and the value changed elsewhere (or first render): take it from the settings.
    if (!el._pending && el._v !== getKey(key)) {
      el._v = shown(el, getKey(key));
      const cur = el.querySelector('.val > span:not(.out)');
      if (cur) cur.textContent = stepperText(el, el._v);
    }
    if (!el.children.length) {
      el.innerHTML = `<button aria-label="Less">${minus}</button><span class="val" aria-live="polite"><span>${stepperText(el, el._v)}</span></span><button aria-label="More">${plus}</button>`;
      const [dec, inc] = el.querySelectorAll('button');
      dec.addEventListener('click', () => step(el, -1));
      inc.addEventListener('click', () => step(el, 1));
      if (isFree(el)) {
        const val = el.querySelector('.val');
        val.title = 'Click to type';
        val.addEventListener('click', () => editStepper(el));
      }
    }
    setButtons(el);
  });
}
const minus = '<svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 5.5h7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const plus = '<svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 5.5h7M5.5 2v7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// Click the value to type your own: Enter or clicking away keeps it, Escape puts the old one back.
function editStepper(el) {
  const val = el.querySelector('.val');
  if (val.querySelector('input')) return;
  const [min, max] = el.dataset.free.split(',').map(Number);
  const input = document.createElement('input');
  Object.assign(input, { type: 'number', min, max, step: 1, value: el._v });
  input.setAttribute('aria-label', 'Type a value');
  val.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    input.remove();
    const n = Math.round(Number(input.value));
    if (!keep || !input.value.trim() || !Number.isFinite(n)) return;
    const v = Math.max(min, Math.min(max, n));
    if (v !== el._v) setStepper(el, v, v > el._v ? 1 : -1);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function step(el, dir) {
  const v = neighbor(el, el._v, dir);
  if (v !== undefined) setStepper(el, v, dir);
}
// The old value rolls away and the new one springs in from the direction you stepped.
function setStepper(el, v, dir) {
  const key = el.dataset.key;
  el._v = v;
  const val = el.querySelector('.val');
  // Labels still rolling away from earlier clicks go now, so only one old and one new are ever shown.
  val.querySelectorAll(':scope > span.out').forEach((s) => s.remove());
  const old = val.querySelector(':scope > span');
  const next = document.createElement('span');
  next.textContent = stepperText(el, v);
  val.appendChild(next);
  if (old) {
    old.classList.add('out');
    old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-dir * 14}px)`, opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' })
      .finished.then(() => old.remove(), () => {});
  }
  next.animate([{ transform: `translateY(${dir * 14}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: BOUNCY });
  // Buttons follow the shown value right away, not when the save comes back.
  setButtons(el);
  el._pending = (el._pending || 0) + 1;
  save(patchFor(key, v)).finally(() => { el._pending--; });
}

// ---------- login ----------
document.querySelectorAll('.switch.login').forEach((b) => b.addEventListener('click', () => save({ openAtLogin: !S.openAtLogin })));

// ---------- access + status ----------
let grantedChecks = 0;
function swapText(el, text) {
  if (el.textContent === text) return;
  el.classList.add('out');
  setTimeout(() => { el.textContent = text; el.classList.remove('out'); }, 160);
}
// ---------- on / off ----------
$('power').addEventListener('click', () => { $('power').blur(); save({ enabled: !S.enabled }).then(updateStatus); });
scrawl.on('settings:changed', (s) => { S = s; update(); updateStatus(); }); // e.g. from the Pane menu

function updateStatus() {
  const { trusted, listening: on } = status;
  const enabled = S.enabled !== false;
  $('power').classList.toggle('off', !enabled);
  $('power').setAttribute('aria-pressed', enabled);
  swapText($('powerText'), enabled ? 'Turn off' : 'Turn on');
  $('page').classList.toggle('off', !enabled);
  grantedChecks = trusted && !on ? grantedChecks + 1 : 0;
  const needsRestart = trusted && !on && grantedChecks >= 3;
  // Every tool page asks, until access is granted (or Pane needs a restart to pick it up).
  document.querySelectorAll('.access').forEach((el) => el.classList.toggle('open', !on && (!trusted || needsRestart)));
  document.querySelectorAll('.access-btn').forEach((btn) => {
    btn.textContent = needsRestart ? 'Restart Pane' : 'Open Accessibility settings';
    btn.onclick = () => scrawl.send(needsRestart ? 'app:relaunch' : 'perm:open');
  });
  $('status').classList.toggle('ready', on && enabled);
  swapText($('statusText'), !enabled
    ? 'Off. Your keys work as normal.'
    : on
      ? `On. ${S.wheelMode === 'double' ? `Tap ${keyText(S.hotkey)}, then tap and hold it` : `Hold ${keyText(S.hotkey)}`} for the wheel, ${keyText(S.drawKey)} to draw.`
      : trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
  if (typeof updateAwayStatus === 'function') updateAwayStatus();
  if (typeof updateSpinStatus === 'function') updateSpinStatus();
  if (typeof updateJotStatus === 'function') updateJotStatus();
  if (typeof updateTweakStatus === 'function') updateTweakStatus();
  if (typeof updateDebugStatus === 'function') updateDebugStatus();
}
async function pollStatus() {
  status = await scrawl.invoke('perm:check');
  updateStatus();
}

// Entrance animations hold their end state; drop them once played so hover and press transforms can take over.
document.addEventListener('animationend', (e) => {
  if (e.animationName === 'pop' || e.animationName === 'rise') e.target.classList.remove('pop', 'rise');
});

// ---------- go ----------
function update() {
  renderSegs();
  for (const which of Object.keys(KEY_NAMES)) if (listening !== which) renderKey(which);
  $('scrawlLede').textContent = S.wheelMode === 'double'
    ? 'Tap the wheel key, then tap it again and hold. Slide to a tool and let go. Drag to draw. Press Esc when you’re done.'
    : 'Hold the wheel key, slide to a tool and let go. Drag to draw. Press Esc when you’re done.';
  renderPreview();
  renderTiles();
  renderSwatches();
  renderSteppers();
  document.querySelectorAll('.switch.login').forEach((b) => b.setAttribute('aria-checked', S.openAtLogin));
  if (typeof updateAway === 'function') updateAway();
  if (typeof updateSpin === 'function') updateSpin();
  if (typeof updateJot === 'function') updateJot();
  if (typeof updateTweak === 'function') updateTweak();
  if (typeof updateDebug === 'function') updateDebug();
}

// Wait for every page's script (away-settings.js, spin-settings.js) before the first render: the
// reply can otherwise arrive while they're still loading, and their pages would miss it.
const domReady = new Promise((r) => (document.readyState === 'loading' ? addEventListener('DOMContentLoaded', r, { once: true }) : r()));
domReady.then(() => scrawl.invoke('settings:get')).then(({ settings, version }) => {
  S = settings;
  document.querySelectorAll('.version').forEach((v) => { v.textContent = version ? `Version ${version}` : ''; });
  ['hotkey', 'drawKey', 'spinKey', 'jotKey', 'tweakKey', 'awayKey', 'debugKey'].forEach((which, i) => {
    renderKey(which, true);
    wellFor(which).querySelector('.keycap').style.setProperty('--d', `${260 + i * 80}ms`);
  });
  update();
  resetCaptions();
  if (typeof startSwitcher === 'function') startSwitcher();
  pollStatus();
  setInterval(pollStatus, 1500);
});
