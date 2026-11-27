// Plugin's picker: one of these covers each screen while you choose an app. The main process does the
// pointing (it knows every window's frame, from Pane's helper) and tells this page what to outline.
// Clicks come from the global hook, like Tweak's pointer: this layer takes them, so nothing lands beneath.
//
// A window you point at: the veil opens over it and a ring is drawn just inside its edge. An app in the tray:
// the veil stays whole and the tile lights up itself (the tray sits above the veil). Either way the name tag
// is placed by hand, kept on screen and clear of the hint at the top.
const $ = (id) => document.getElementById(id);
const primary = new URLSearchParams(location.search).get('primary') === '1';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (a, size) => (a.icon ? `<img src="${a.icon}" alt="" width="${size}" height="${size}">` : `<span class="avatar">${esc((a.name || '?').slice(0, 1))}</span>`);

let shown = null; // what's outlined: `${kind}:${pid}:${x},${y},${w},${h}`
let lastPid = null;
let center = { x: innerWidth / 2, y: innerHeight / 2 };

function box(el, r, radius) {
  const s = el.style;
  s.left = `${r.x}px`; s.top = `${r.y}px`; s.width = `${r.w}px`; s.height = `${r.h}px`;
  if (radius != null) s.borderRadius = `${radius}px`;
}
// The veil closes to a point (where the last thing was), so the whole screen is veiled.
function closeSpot() { box($('spot'), { x: center.x, y: center.y, w: 0, h: 0 }); }

function placeTag(h) {
  const tag = $('tag');
  const tw = tag.offsetWidth, th = tag.offsetHeight, W = innerWidth, H = innerHeight;
  let x, y;
  if (h.kind === 'tray') {
    // Above the tray, centered on the tile.
    const tray = $('tray').getBoundingClientRect();
    x = h.x + h.w / 2 - tw / 2;
    y = tray.top - th - 10;
  } else {
    // Inside the window's top-left corner, past the ring.
    x = Math.max(h.x, 0) + 14;
    y = Math.max(h.y, 0) + 14;
  }
  x = Math.min(Math.max(x, 8), W - tw - 8);
  y = Math.min(Math.max(y, 8), H - th - 8);
  // Never under the hint: drop below it instead.
  const hint = $('hint');
  if (!hint.hidden) {
    const r = hint.getBoundingClientRect();
    if (x < r.right && x + tw > r.left && y < r.bottom + 6 && y + th > r.top) y = r.bottom + 10;
  }
  tag.style.left = `${Math.round(x)}px`;
  tag.style.top = `${Math.round(y)}px`;
}

function show(h) {
  const ring = $('ring'), tag = $('tag');
  document.querySelectorAll('.tile.hot').forEach((t) => t.classList.remove('hot'));
  if (!h) {
    if (!shown) return;
    shown = null;
    ring.classList.remove('on');
    tag.classList.remove('on');
    closeSpot();
    return;
  }
  const key = `${h.kind}:${h.pid}:${h.x},${h.y},${h.w},${h.h}`;
  if (key === shown) return;
  shown = key;
  if (h.kind === 'tray') {
    ring.classList.remove('on');
    closeSpot();
    document.querySelector(`.tile[data-pid="${h.pid}"]`)?.classList.add('hot');
  } else {
    // A full-screen window has square corners; normal windows round theirs.
    const radius = h.flat ? 0 : 12;
    box($('spot'), h, radius);
    box(ring, h, radius);
    ring.classList.add('on');
    center = { x: h.x + h.w / 2, y: h.y + h.h / 2 };
  }
  tag.classList.toggle('plugged', !!h.plugged);
  if (lastPid !== h.pid) {
    lastPid = h.pid;
    $('tagIc').innerHTML = icon(h, 30);
    $('tagName').textContent = h.name;
    tag.classList.remove('swap'); void tag.offsetWidth; tag.classList.add('swap');
  }
  $('tagHint').textContent = h.plugged ? 'Plugged in. Click to open its plugin.' : 'Click to plug in';
  placeTag(h);
  tag.classList.add('on');
}

function renderTray(apps) {
  const tray = $('tray');
  if (!primary || !apps?.length) { tray.hidden = true; return; }
  tray.hidden = false;
  tray.innerHTML = apps.map((a, k) => `<div class="tile" data-pid="${a.pid}" style="--k:${k}">${icon(a, 38)}<span>${esc(a.name)}</span>${a.plugged ? '<i class="on"></i>' : ''}</div>`).join('');
  // The main process does the pointing, so it needs to know where each tile is. Measured once the tray and its
  // tiles have landed (their entrance moves them), and again in case.
  const measure = () => {
    const tiles = [...tray.querySelectorAll('.tile')].map((t) => {
      const r = t.getBoundingClientRect();
      return { pid: Number(t.dataset.pid), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    scrawl.send('pick:tray', tiles);
  };
  setTimeout(measure, 120);
  setTimeout(measure, 900);
}

scrawl.invoke('pick:init').then(({ apps }) => {
  $('hintMark').innerHTML = Tools.glyph('plugin', 21);
  $('hint').hidden = !primary;
  renderTray(apps);
  closeSpot();
  requestAnimationFrame(() => document.body.classList.add('in'));
});
scrawl.on('pick:hit', show);
scrawl.on('pick:apps', renderTray);
scrawl.on('pick:nope', () => { document.body.classList.remove('nope'); void document.body.offsetWidth; document.body.classList.add('nope'); });
// Leaving. Picked a window: the ring shrinks into its bottom-right corner, where the plug lands.
scrawl.on('pick:leave', ({ to } = {}) => {
  $('tag').classList.remove('on');
  if (to && shown && !shown.startsWith('tray')) {
    document.body.classList.add('picked');
    box($('spot'), to, 16);
    box($('ring'), to, 16);
  } else document.body.classList.add('out');
});
