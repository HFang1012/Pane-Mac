const $ = (id) => document.getElementById(id);
const BOUNCY = getComputedStyle(document.documentElement).getPropertyValue('--bouncy').trim();
const COLORS = Wheel.COLORS; // shared with the wheel's color ring

let S = null;
let status = { trusted: false, listening: false };

async function save(patch) {
  S = await scrawl.invoke('settings:set', patch);
  update();
}

// ---------- held keys: Scrawl's wheel key and draw key, and Spin's key ----------
// (Away's keys are a shortcut, chosen in away-settings.js; its well has no data-which.)
const wells = [...document.querySelectorAll('.keywell[data-which]')];
const wellFor = (which) => wells.find((w) => w.dataset.which === which);
const KEY_NAMES = { hotkey: 'Wheel key', drawKey: 'Draw key', spinKey: 'Spin key', jotKey: 'Jot key' };
const DEFAULT_CAPTION = 'Click a key to change it. Hold several to use them together.';
const JOT_CAPTION = 'Click the key to change it. Tap it twice, quickly.';
let listening = null; // which key is being chosen
const keyOf = (which) => (which === 'spinKey' ? S.spin.key : which === 'jotKey' ? S.jot.key : S[which]);

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
const captionFor = (which) => (which === 'spinKey' ? $('spinCaption') : which === 'jotKey' ? $('jotCaption') : $('keycaption'));
function setCaption(text, warn = false, which = listening) {
  const c = captionFor(which);
  c.textContent = text;
  c.classList.toggle('warn', warn);
}
for (const well of wells) {
  well.addEventListener('click', async () => {
    well.blur(); // the next key press shouldn't paint a focus ring on the button
    const which = well.dataset.which;
    if (typeof cancelAwayListening === 'function') cancelAwayListening();
    if (typeof cancelJotListening === 'function') cancelJotListening();
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
    setCaption(which === 'jotKey' ? 'Press ⌃, ⌥, ⇧ or ⌘. Esc cancels.' : 'Hold one key, or a few together. Esc cancels.', false, which);
  });
}
function stopListening(popWhich = null) {
  for (const w of wells) w.classList.remove('listening');
  listening = null;
  for (const which of Object.keys(KEY_NAMES)) renderKey(which, popWhich === which);
  setCaption(DEFAULT_CAPTION, false, 'hotkey');
  setCaption(DEFAULT_CAPTION, false, 'spinKey');
  if (S?.jot?.mode !== 'shortcut') setCaption(JOT_CAPTION, false, 'jotKey');
}
scrawl.on('bind:done', ({ settings, which, error }) => {
  S = settings;
  stopListening(error ? null : which);
  if (error) { setCaption(error, true, which); shake(wellFor(which)); }
  updateStatus();
});

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
function renderSteppers() {
  document.querySelectorAll('.stepper').forEach((el) => {
    const key = el.dataset.key;
    const values = el.dataset.values.split(',').map(Number);
    // Nothing in flight and the value changed elsewhere (or first render): take it from the settings.
    if (!el._pending && el._v !== getKey(key)) {
      el._v = getKey(key);
      const cur = el.querySelector('.val > span:not(.out)');
      if (cur) cur.textContent = stepperText(el, values[Math.max(0, values.indexOf(getKey(key)))]);
    }
    let idx = Math.max(0, values.indexOf(el._v));
    if (!el.children.length) {
      el.innerHTML = `<button aria-label="Less">${minus}</button><span class="val" aria-live="polite"><span>${stepperText(el, values[idx])}</span></span><button aria-label="More">${plus}</button>`;
      const [dec, inc] = el.querySelectorAll('button');
      dec.addEventListener('click', () => step(el, -1));
      inc.addEventListener('click', () => step(el, 1));
    }
    const [dec, inc] = el.querySelectorAll('button');
    dec.disabled = idx === 0;
    inc.disabled = idx === values.length - 1;
  });
}
const minus = '<svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 5.5h7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const plus = '<svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 5.5h7M5.5 2v7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// The old value rolls away and the new one springs in from the direction you stepped.
function step(el, dir) {
  const key = el.dataset.key;
  const values = el.dataset.values.split(',').map(Number);
  const idx = Math.max(0, values.indexOf(el._v)) + dir;
  if (idx < 0 || idx >= values.length) return;
  el._v = values[idx];
  const val = el.querySelector('.val');
  // Labels still rolling away from earlier clicks go now, so only one old and one new are ever shown.
  val.querySelectorAll(':scope > span.out').forEach((s) => s.remove());
  const old = val.querySelector(':scope > span');
  const next = document.createElement('span');
  next.textContent = stepperText(el, values[idx]);
  val.appendChild(next);
  if (old) {
    old.classList.add('out');
    old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-dir * 14}px)`, opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' })
      .finished.then(() => old.remove(), () => {});
  }
  next.animate([{ transform: `translateY(${dir * 14}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: BOUNCY });
  // Buttons follow the shown value right away, not when the save comes back.
  const [dec, inc] = el.querySelectorAll('button');
  dec.disabled = idx === 0;
  inc.disabled = idx === values.length - 1;
  el._pending = (el._pending || 0) + 1;
  save(patchFor(key, values[idx])).finally(() => { el._pending--; });
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
      ? `On. Hold ${keyText(S.hotkey)} for the wheel, ${keyText(S.drawKey)} to draw.`
      : trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
  if (typeof updateAwayStatus === 'function') updateAwayStatus();
  if (typeof updateSpinStatus === 'function') updateSpinStatus();
  if (typeof updateJotStatus === 'function') updateJotStatus();
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
  renderPreview();
  renderTiles();
  renderSwatches();
  renderSteppers();
  document.querySelectorAll('.switch.login').forEach((b) => b.setAttribute('aria-checked', S.openAtLogin));
  if (typeof updateAway === 'function') updateAway();
  if (typeof updateSpin === 'function') updateSpin();
  if (typeof updateJot === 'function') updateJot();
}

// Wait for every page's script (away-settings.js, spin-settings.js) before the first render: the
// reply can otherwise arrive while they're still loading, and their pages would miss it.
const domReady = new Promise((r) => (document.readyState === 'loading' ? addEventListener('DOMContentLoaded', r, { once: true }) : r()));
domReady.then(() => scrawl.invoke('settings:get')).then(({ settings, version }) => {
  S = settings;
  document.querySelectorAll('.version').forEach((v) => { v.textContent = version ? `Version ${version}` : ''; });
  ['hotkey', 'drawKey', 'spinKey', 'jotKey'].forEach((which, i) => {
    renderKey(which, true);
    wellFor(which).querySelector('.keycap').style.setProperty('--d', `${260 + i * 80}ms`);
  });
  update();
  if (typeof startSwitcher === 'function') startSwitcher();
  pollStatus();
  setInterval(pollStatus, 1500);
});
