// A plugin's badge: the little pill on its app's bottom-right corner. Its light says whether the plugin is
// on and how it's doing; the words say what it's doing right now; the bars show each share at a glance.
// Click it for the plugin's menu. The main process moves the window with the app's.
const $ = (id) => document.getElementById(id);
const ORDER = ['cpu', 'ram', 'net', 'out', 'mic'];
const NAMES = { cpu: 'Processor', ram: 'Memory', net: 'Network', out: 'Sound', mic: 'Microphone' };
let view = null;

function setText(text) {
  const st = $('st');
  if (st.textContent === text) return;
  st.classList.add('out');
  setTimeout(() => { st.textContent = text; st.classList.remove('out'); fit(); }, 150);
}
function pips(levels) {
  $('pips').innerHTML = ORDER.map((a, k) => {
    const L = levels[a];
    const cls = L === 12 ? 'od' : L === 11 ? 'boost' : L >= 1 && L < 10 ? 'lim' : '';
    const h = L >= 1 && L < 10 ? 2 + L * 0.9 : L >= 11 ? 11 : 4;
    return `<i class="${cls}" style="--k:${k};height:${h}px" title="${NAMES[a]}"></i>`;
  }).join('');
}
function render(v) {
  const sig = JSON.stringify([v.status, v.levels, v.on]);
  if (view && JSON.stringify([view.status, view.levels, view.on]) === sig) { view = v; return; }
  view = v;
  document.body.dataset.tone = v.status.tone;
  setText(v.status.text);
  pips(v.levels);
  $('pill').title = `${v.name}’s plugin${v.on ? '' : ' (off)'}. Click to open it, drag to move it.`;
  $('pill').setAttribute('aria-label', `${v.name} plugin: ${v.status.text}. Open plugin menu.`);
}
let fitFrame = 0;
function fit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    const w = $('wrap');
    scrawl.send('badge:fit', { w: Math.ceil(w.offsetWidth), h: Math.ceil(w.offsetHeight) });
  });
}
// Drag it anywhere on its window; a press that doesn't move is a click (opens or closes the menu). The page
// sends where the pointer is on screen and the main process moves the window, like Debug's pill.
const drag = { id: null, x: 0, y: 0, moved: false };
$('pill').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  $('pill').setPointerCapture(e.pointerId);
  Object.assign(drag, { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false });
});
$('pill').addEventListener('pointermove', (e) => {
  if (drag.id !== e.pointerId) return;
  if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 4) return;
  if (!drag.moved) { drag.moved = true; document.body.classList.add('dragging'); scrawl.send('badge:drag', 'start', { x: drag.x, y: drag.y }); }
  scrawl.send('badge:drag', 'move', { x: e.screenX, y: e.screenY });
});
const endDrag = (e) => {
  if (drag.id !== e.pointerId) return;
  drag.id = null;
  document.body.classList.remove('dragging');
  if (drag.moved) scrawl.send('badge:drag', 'end', { x: e.screenX, y: e.screenY });
  else if (e.type === 'pointerup') scrawl.send('badge:click');
};
$('pill').addEventListener('pointerup', endDrag);
$('pill').addEventListener('pointercancel', endDrag);
$('pill').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrawl.send('badge:click'); } });

scrawl.on('badge:data', (v) => { const first = !view; render(v); if (first) fit(); });
scrawl.on('badge:show', (o) => {
  document.body.classList.remove('out', 'unplug', 'in');
  document.body.classList.toggle('again', !o?.first);
  void document.body.offsetWidth;
  document.body.classList.add('in');
});
scrawl.on('badge:hide', () => { if (document.body.classList.contains('in')) { document.body.classList.remove('in'); document.body.classList.add('out'); } });
scrawl.on('badge:unplug', () => { document.body.classList.remove('out'); document.body.classList.add('unplug'); });
fit();
