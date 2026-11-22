// The Spin page of the settings window. Shares S, save(), shake(), swapText(), status and the held-key
// chooser (the Spin key's well is one of settings.js's wells) with settings.js.
// Spotify isn't linked (yet), so there are no playlists to list. Assumed until Spotify says otherwise, so the
// playlists row can only appear on load, never show and then fold away.
let plNeedsLink = true;

// ---------- which music app ----------
// Plain glyphs, not the apps' own logos: a streaming record, a note, and a media keycap.
const APP_GLYPHS = {
  spotify: () => {
    const c = Tools.SPIN_COLORS;
    // Headphones (a streaming app), not Spotify's own mark.
    const band = '<path d="M12 27v-5a16 16 0 0 1 32 0v5" fill="none" stroke-width="5" stroke-linecap="round"/>';
    const cups = '<rect x="9" y="24" width="10" height="15" rx="4" stroke="none"/><rect x="37" y="24" width="10" height="15" rx="4" stroke="none"/>';
    return `<svg viewBox="0 0 56 44" aria-hidden="true"><g transform="translate(0 3)" fill="${c.inkLip}" stroke="${c.inkLip}">${band}</g><g fill="${c.ink}" stroke="${c.ink}">${band}</g>` +
      `<g transform="translate(0 3)" fill="${c.mintLip}">${cups}</g><g fill="${c.mint}">${cups}</g></svg>`;
  },
  music: () => {
    const c = Tools.SPIN_COLORS;
    const note = '<path d="M22 31V12l17-4v19" fill="none" stroke-width="5" stroke-linejoin="round"/><circle cx="18" cy="31" r="6"/><circle cx="35" cy="27" r="6"/>';
    return `<svg viewBox="0 0 56 44" aria-hidden="true"><g transform="translate(0 3)" fill="#D96F8A" stroke="#D96F8A">${note}</g><g fill="#F49CB0" stroke="#F49CB0">${note}</g></svg>`;
  },
  other: () => {
    const c = Tools.SPIN_COLORS;
    return `<svg viewBox="0 0 56 44" aria-hidden="true"><rect x="8" y="10" width="40" height="27" rx="8" fill="${c.mustardLip}"/><rect x="8" y="7" width="40" height="27" rx="8" fill="${c.mustard}"/>` +
      `<g fill="${c.ink}"><path d="M18 14v13l9-6.5z"/><rect x="30" y="14" width="3.6" height="13" rx="1.2"/><rect x="36.5" y="14" width="3.6" height="13" rx="1.2"/></g></svg>`;
  },
};
const APP_INFO = {
  spotify: { name: 'Spotify', sub: 'Its own volume' },
  music: { name: 'Music', sub: 'Its own volume' },
  other: { name: 'Any player', sub: 'Media keys' },
};
const appsEl = document.getElementById('apps');
function renderApps() {
  if (!appsEl.children.length) {
    Object.entries(APP_INFO).forEach(([id, info], i) => {
      const el = document.createElement('button');
      el.className = 'tile pop';
      el.style.setProperty('--d', `${200 + i * 50}ms`);
      el.dataset.app = id;
      el.setAttribute('role', 'radio');
      el.innerHTML = `<span class="glyph">${APP_GLYPHS[id]()}</span><span class="name">${info.name}</span><small>${info.sub}</small>` +
        '<span class="check" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" fill="none" stroke="#FBF8F3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
      el.addEventListener('click', () => {
        el.blur();
        if (S.spin.app === id) return;
        saveSpin({ app: id }).then(() => { plShown = ''; checkNow(); loadPlaylists(); });
      });
      appsEl.appendChild(el);
    });
  }
  for (const el of appsEl.children) {
    const on = el.dataset.app === S.spin.app;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on);
  }
  document.getElementById('spotifyRow').hidden = S.spin.app !== 'spotify';
  // Unlinked, the playlists row would only say "link Spotify below", so it waits until there's a list.
  document.getElementById('playlistRow').hidden = S.spin.app === 'other' || (S.spin.app === 'spotify' && plNeedsLink);
}

// ---------- the preview: Spin's wheel, small ----------
let previewKey = '', spinPreviewNp = null, spinPreviewHot = -1;
const spinLayout = (wheel = S.spin.wheel) => wheel.filter((x) => x.on).map((x) => x.id);
function renderSpinPreview(np = spinPreviewNp, layout = spinLayout()) {
  spinPreviewNp = np;
  const key = `${np?.state}|${np?.track?.id}|${np?.track?.art ? 1 : 0}|${layout.join()}`;
  if (key === previewKey) return;
  const first = !previewKey;
  previewKey = key;
  const el = document.getElementById('spinPreview');
  el.innerHTML = Spin.build({ size: 40, np, compact: true, enter: first, layout });
  Spin.setHover(el.querySelector('svg'), spinPreviewHot, { np, size: 40, layout });
}
function hoverSpinPreview(id) {
  spinPreviewHot = id && spinLayout().includes(id) ? Spin.SLICE[id] : -1;
  Spin.setHover(document.querySelector('#spinPreview svg'), spinPreviewHot, { np: spinPreviewNp, size: 40, layout: spinLayout() });
}

// ---------- the wheel's slices: click one off or on, drag to reorder ----------
const slicesEl = document.getElementById('slices');
const sliceEls = new Map();
let sliceDrag = null; // { id, el, startX, grabX, moved, order }
const SLICE_NAMES = { play: 'Play', next: 'Next', volume: 'Volume', prev: 'Previous', lists: 'Playlists' };
const sliceGlyph = (id) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${Spin.ICONS[id]}</svg>`;
const saveWheel = (wheel) => saveSpin({ wheel });
function toggleSlice(id, el) {
  const w = S.spin.wheel, x = w.find((s) => s.id === id);
  if (x.on && w.filter((s) => s.on).length === 1) {
    shake(el);
    sliceHint('The wheel needs at least one slice.');
    return;
  }
  saveWheel(w.map((s) => (s.id === id ? { ...s, on: !s.on } : s))).then(() => hoverSpinPreview(null));
}
let sliceHintTimer;
function sliceHint(text) {
  const p = document.getElementById('slicesHint');
  p.textContent = text;
  p.style.color = 'var(--accent-ink)';
  clearTimeout(sliceHintTimer);
  sliceHintTimer = setTimeout(() => { p.textContent = 'Click to take a slice off the wheel. Drag to reorder.'; p.style.color = ''; }, 2200);
}
function makeSliceTile(id, i) {
  const el = document.createElement('div');
  el.className = 'tile pop';
  el.style.setProperty('--d', `${220 + i * 40}ms`);
  el.tabIndex = 0;
  el.setAttribute('role', 'switch');
  el.innerHTML = `<span class="glyph">${sliceGlyph(id)}</span><span class="name">${SLICE_NAMES[id]}</span>` +
    '<span class="check" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" fill="none" stroke="#FBF8F3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSlice(id, el); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const w = [...S.spin.wheel], from = w.findIndex((s) => s.id === id), to = from + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to < 0 || to >= w.length) return;
      w.splice(to, 0, w.splice(from, 1)[0]);
      saveWheel(w).then(() => el.focus());
    }
  });
  el.addEventListener('mouseenter', () => { if (!sliceDrag) hoverSpinPreview(id); });
  el.addEventListener('mouseleave', () => { if (!sliceDrag) hoverSpinPreview(null); });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sliceDrag) return;
    const r = el.getBoundingClientRect();
    sliceDrag = { id, el, startX: e.clientX, startY: e.clientY, grabX: e.clientX - r.left, moved: false, order: S.spin.wheel.map((s) => s.id) };
    try { slicesEl.setPointerCapture(e.pointerId); } catch {}
  });
  return el;
}
// All slice tiles are the same width, so a slot is just an index along the row.
function sliceSlot(x) {
  const r = slicesEl.getBoundingClientRect(), n = sliceEls.size;
  const w = (r.width + 6) / n;
  return { idx: Math.max(0, Math.min(n - 1, Math.round((x - r.left) / w))), left: (k) => r.left + k * w };
}
addEventListener('pointermove', (e) => {
  const d = sliceDrag;
  if (!d) return;
  const dy = e.clientY - d.startY;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.startX, dy) < 5) return;
    d.moved = true;
    d.el.classList.add('dragging');
  }
  const x = e.clientX - d.grabX;
  const slot = sliceSlot(x);
  if (slot.idx !== d.order.indexOf(d.id)) {
    d.order.splice(slot.idx, 0, d.order.splice(d.order.indexOf(d.id), 1)[0]);
    arrangeSlices(d.order, d.id);
    renderSpinPreview(undefined, d.order.filter((id) => S.spin.wheel.find((s) => s.id === id).on));
  }
  d.el.style.translate = `${x - slot.left(d.order.indexOf(d.id))}px ${dy * 0.3}px`;
});
function endSliceDrag(e) {
  const d = sliceDrag;
  if (!d) return;
  sliceDrag = null;
  const under = e.clientX != null ? document.elementFromPoint(e.clientX, e.clientY) : null;
  if (!d.moved) { if (e.type === 'pointerup' && d.el.contains(under)) toggleSlice(d.id, d.el); return; }
  const from = d.el.style.translate || '0px 0px';
  d.el.style.translate = '';
  d.el.classList.remove('dragging');
  d.el.animate([{ translate: from }, { translate: '0px 0px' }], { duration: 480, easing: BOUNCY });
  if (d.order.join() !== S.spin.wheel.map((s) => s.id).join()) saveWheel(d.order.map((id) => S.spin.wheel.find((s) => s.id === id)));
}
addEventListener('pointerup', endSliceDrag);
addEventListener('pointercancel', endSliceDrag);
addEventListener('blur', () => endSliceDrag({ type: 'blur' }));
// FLIP: move the nodes, then slide each tile from where it was.
function arrangeSlices(ids, skip = null) {
  const before = new Map([...sliceEls].map(([id, el]) => [id, el.getBoundingClientRect().left]));
  ids.forEach((id) => slicesEl.appendChild(sliceEls.get(id)));
  for (const [id, el] of sliceEls) {
    if (id === skip) continue;
    const dx = before.get(id) - el.getBoundingClientRect().left;
    if (Math.abs(dx) > 1) el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: 440, easing: BOUNCY });
  }
}
function renderSlices() {
  const w = S.spin.wheel;
  w.forEach((s, i) => {
    if (!sliceEls.has(s.id)) { const el = makeSliceTile(s.id, i); sliceEls.set(s.id, el); slicesEl.appendChild(el); }
    const el = sliceEls.get(s.id);
    el.classList.toggle('on', s.on);
    el.setAttribute('aria-checked', s.on);
    el.setAttribute('aria-label', `${SLICE_NAMES[s.id]}: ${s.on ? 'on' : 'off'} the wheel, position ${i + 1}. Arrow keys move it.`);
  });
  const current = [...slicesEl.children].map((el) => [...sliceEls].find(([, x]) => x === el)[0]);
  if (!sliceDrag && current.join() !== w.map((s) => s.id).join()) arrangeSlices(w.map((s) => s.id));
}

// ---------- now playing: proof the link works, or what's missing ----------
const NAMES = { spotify: 'Spotify', music: 'Music', other: 'your player' };
let nowTimer = null;
async function checkNow() {
  clearTimeout(nowTimer);
  let r;
  try { r = await scrawl.invoke('spin:status'); } catch { return; }
  showNow(r);
  showSpotify(r.spotify, r.redirect);
  if (plLoaded) loadPlaylists(); // cheap: the list is kept a minute, this mostly moves the check mark
  // Keep it fresh while the page is open (cheap: one quick question to the app).
  nowTimer = setTimeout(() => { if (!document.getElementById('spinPage').hidden && document.hasFocus()) checkNow(); else nowTimer = setTimeout(checkNow, 4000); }, 4000);
}
function showNow({ np, error, list }) {
  const app = S.spin.app, name = NAMES[app];
  const title = document.getElementById('nowTitle'), sub = document.getElementById('nowSub');
  const fix = document.getElementById('nowFix'), rec = document.getElementById('nowRec');
  fix.hidden = true;
  rec.classList.toggle('turning', np?.state === 'playing');
  const art = np?.track?.art;
  if (rec.dataset.art !== (art || '')) {
    rec.dataset.art = art || '';
    rec.innerHTML = art ? `<img alt="" src="${art.replace(/"/g, '&quot;')}">` : '';
  }
  if (error === 'denied') {
    title.textContent = `Pane isn’t allowed to control ${name}`;
    sub.textContent = 'Turn on Pane under Automation in Privacy & Security.';
    fix.hidden = false;
  } else if (error) {
    title.textContent = `Couldn’t reach ${name}`;
    sub.textContent = 'Try again in a moment.';
  } else if (app === 'other') {
    title.textContent = 'Media keys';
    sub.textContent = 'Play, skip and back go to whichever player is on. Volume is the Mac’s.';
  } else if (!np?.running) {
    title.textContent = `${name} isn’t open`;
    sub.textContent = 'Open it and Spin is ready.';
  } else if (np.track) {
    title.textContent = np.track.title;
    const songs = list ? ` · ${list.items.length} songs in the list` : '';
    sub.textContent = `${np.track.artist || ''}${songs}`;
  } else {
    title.textContent = 'Nothing playing';
    sub.textContent = `${name} is open.`;
  }
  renderSpinPreview(np);
}
document.getElementById('nowFix').addEventListener('click', () => scrawl.send('spin:automation'));

// ---------- playlists ----------
// Pick one and it plays from the top in the music app, without bringing that app to the front.
const plList = document.getElementById('plList'), plNote = document.getElementById('plNote');
let plLoaded = false, plShown = '', plBusy = false;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function loadPlaylists(fresh = false) {
  if (S.spin.app === 'other' || plBusy) return;
  plLoaded = true;
  const app = S.spin.app;
  if (!plShown) plNote.textContent = 'Looking for playlists…';
  let r;
  try { r = await scrawl.invoke('spin:playlists', { fresh }); } catch { return; }
  if (app !== S.spin.app) return; // switched apps while it looked
  showPlaylists(r);
}
function showPlaylists(r) {
  const name = NAMES[S.spin.app];
  let note = '';
  if (r.error === 'denied') note = `Pane isn’t allowed to control ${name} yet.`;
  else if (r.error) note = `Couldn’t get ${name}’s playlists. Try Refresh.`;
  else if (r.needsLink) note = 'Link Spotify below to choose from your playlists.';
  else if (r.running === false) note = `Open ${name} to choose a playlist.`;
  else if (!r.items?.length) note = 'No playlists yet.';
  plNote.textContent = note;
  plNeedsLink = !!r.needsLink && !r.error;
  document.getElementById('playlistRow').hidden = S.spin.app === 'other' || (S.spin.app === 'spotify' && plNeedsLink);
  const items = note ? [] : r.items;
  // Only rebuild when the list itself changed, so scrolling and hovering aren't disturbed.
  const key = items.map((p) => p.id).join('|');
  if (key !== plShown) {
    plShown = key;
    plList.innerHTML = items.map((p) => {
      const disc = p.art ? `<img alt="" src="${esc(p.art)}">` : `<i style="--c:${Spin.labelColor({ title: p.name })}"></i>`;
      const count = p.count != null ? `${p.count} song${p.count === 1 ? '' : 's'}` : '';
      return `<button class="pl" role="listitem" data-id="${esc(p.id)}"><span class="disc">${disc}</span><b>${esc(p.name)}</b><small>${count}</small></button>`;
    }).join('');
  }
  markPlaylist(r.current);
}
function markPlaylist(current) {
  for (const el of plList.children) {
    const on = !!current && el.dataset.id === current;
    if (on !== el.classList.contains('on')) {
      el.classList.toggle('on', on);
      const small = el.querySelector('small');
      if (on) { small.dataset.count = small.textContent; small.textContent = 'Playing'; }
      else if (small.dataset.count != null) small.textContent = small.dataset.count;
    }
  }
}
plList.addEventListener('click', async (e) => {
  const el = e.target.closest('.pl');
  if (!el || plBusy) return;
  el.blur();
  plBusy = true;
  el.classList.add('busy');
  const r = await scrawl.invoke('spin:playlist', el.dataset.id).catch(() => ({ ok: false }));
  el.classList.remove('busy');
  plBusy = false;
  if (!r.ok) {
    shake(el);
    plNote.textContent = r.error === 'denied' ? `Pane isn’t allowed to control ${NAMES[S.spin.app]} yet.` : 'That playlist didn’t start. Try again.';
    return;
  }
  plNote.textContent = '';
  markPlaylist(r.current || el.dataset.id);
  checkNow();
});
document.getElementById('plRefresh').addEventListener('click', (e) => { e.currentTarget.blur(); loadPlaylists(true); });

// ---------- Spotify link ----------
function showSpotify(acct, redirect) {
  if (!acct) return;
  if (redirect) document.getElementById('spotifyRedirect').textContent = redirect;
  document.getElementById('spotifyLinked').hidden = !acct.connected;
  document.getElementById('spotifyLink').hidden = acct.connected;
  plNeedsLink = !acct.connected;
  document.getElementById('playlistRow').hidden = S.spin.app === 'other' || (S.spin.app === 'spotify' && plNeedsLink);
  document.getElementById('spotifyName').textContent = acct.name ? `Spotify linked as ${acct.name}` : 'Spotify linked';
  document.getElementById('spotifyAbout').hidden = acct.connected; // once linked, one line is enough
  document.getElementById('spotifyRelink').hidden = !acct.connected || acct.canPlay !== false;
  const id = document.getElementById('spotifyId');
  if (!id.value && acct.clientId) id.value = acct.clientId;
}
document.getElementById('spotifyDash').addEventListener('click', () => scrawl.send('spin:dashboard'));
document.getElementById('copyRedirect').addEventListener('click', (e) => {
  scrawl.send('clipboard:write', document.getElementById('spotifyRedirect').textContent);
  const b = e.currentTarget;
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = 'Copy'; }, 1400);
});
document.getElementById('spotifyGo').addEventListener('click', async (e) => {
  const btn = e.currentTarget, note = document.getElementById('spotifyNote');
  const id = document.getElementById('spotifyId').value.trim();
  if (!id) { shake(document.getElementById('spotifyId')); return; }
  btn.disabled = true;
  btn.textContent = 'Waiting for Spotify…';
  note.textContent = 'Finish in your browser, then come back.';
  const r = await scrawl.invoke('spotify:connect', id);
  btn.disabled = false;
  btn.textContent = 'Link Spotify';
  note.textContent = r.ok ? '' : r.error;
  if (!r.ok) shake(btn);
  checkNow();
  if (r.ok) { plShown = ''; loadPlaylists(true); }
});
document.getElementById('spotifyUnlink').addEventListener('click', async () => {
  showSpotify(await scrawl.invoke('spotify:disconnect'));
  checkNow();
  plShown = ''; loadPlaylists(true);
});

// ---------- on / off ----------
document.getElementById('spinPower').addEventListener('click', (e) => {
  e.currentTarget.blur();
  saveSpin({ enabled: !S.spin.enabled }).then(updateSpinStatus);
});
function updateSpinStatus() {
  if (!S?.spin) return;
  const on = S.spin.enabled !== false;
  const power = document.getElementById('spinPower');
  power.classList.toggle('off', !on);
  power.setAttribute('aria-pressed', on);
  swapText(document.getElementById('spinPowerText'), on ? 'Turn off' : 'Turn on');
  document.getElementById('spinPage').classList.toggle('off', !on);
  document.getElementById('spinStatus').classList.toggle('ready', on && status.listening);
  swapText(document.getElementById('spinStatusText'), !on
    ? 'Off.'
    : status.listening ? `On. ${S.spin.mode === 'double' ? `Tap ${keyText(S.spin.key)}, then tap and hold it` : `Hold ${keyText(S.spin.key)}`} for the music wheel.` : status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
}

function saveSpin(patch) {
  return save({ spin: { ...S.spin, ...patch } });
}
// Hold the Spin key, or tap it and then tap and hold.
modeSeg(document.getElementById('spinMode'), () => S.spin.mode, (mode) => saveSpin({ mode }));

let spinStarted = false;
function updateSpin() {
  if (!S?.spin) return;
  document.getElementById('spinLede').textContent = S.spin.mode === 'double'
    ? 'Tap the Spin key, then tap it again and hold. Slide to a slice or a song, and let go. Back to the middle cancels.'
    : 'Hold the Spin key, slide to a slice or a song, and let go. Back to the middle cancels.';
  renderApps();
  renderSlices();
  if (spinStarted) renderSpinPreview();
  updateSpinStatus();
  if (!spinStarted) {
    spinStarted = true;
    renderSpinPreview(null);
    if (!spinPage.hidden) { checkNow(); loadPlaylists(); }
  }
}
// Ask the music app only once the Spin page is open (the first ask is when macOS asks you to allow it).
const spinPage = document.getElementById('spinPage');
new MutationObserver(() => { if (!spinPage.hidden && S) { checkNow(); if (!plLoaded) loadPlaylists(); } else clearTimeout(nowTimer); })
  .observe(spinPage, { attributes: true, attributeFilter: ['hidden'] });
