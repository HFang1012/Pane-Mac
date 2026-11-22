// "Show me how": a little screen that plays each tool step by step, pressing the same keys you've set.
const demoEl = document.getElementById('demo');
const stage = document.getElementById('stage');
const cursorEl = document.getElementById('stageCursor');
const inkSvg = document.getElementById('stageInk');
const inkPath = document.getElementById('stagePath');
const wheelBox = document.getElementById('stageWheel');
const keysEl = document.getElementById('demoKeys');
const stepEl = document.getElementById('demoStep');
const dotsEl = document.getElementById('demoDots');
document.getElementById('stageChip').innerHTML = Wheel.icon('pencil', 12);
document.getElementById('stageCup').innerHTML = Tools.glyph('away', 26);

let demoTool = null;
let demoRun = 0; // bumped on every restart or close, so stale timers do nothing
let demoTimers = [];
let demoFrame = 0;
let lastFocus = null;

const later = (ms, fn) => {
  const run = demoRun;
  demoTimers.push(setTimeout(() => { if (run === demoRun) fn(); }, ms));
};
function stopDemo() {
  demoRun++;
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  cancelAnimationFrame(demoFrame);
}

// ---------- the pointer ----------
let at = { x: 0, y: 0 };
function placeCursor(x, y) {
  at = { x, y };
  cursorEl.getAnimations().forEach((a) => a.cancel());
  cursorEl.style.transform = `translate(${x}px, ${y}px)`;
}
function moveCursor(x, y, ms = 600) {
  const from = at;
  placeCursor(x, y);
  cursorEl.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${x}px, ${y}px)` }],
    { duration: ms, easing: 'cubic-bezier(.45,.05,.25,1)' });
}

// ---------- keys and words ----------
function setKeys(keys) {
  keysEl.innerHTML = keys.map((k) =>
    `<div class="dkey" data-k="${k.id}"><span class="cap${k.sym.length > 1 ? ' word' : ''}">${k.sym}</span><small>${k.label}</small></div>`).join('');
}
function press(ids, down) {
  for (const id of ids) keysEl.querySelector(`[data-k="${id}"] .cap`)?.classList.toggle('down', down);
}
function say(i, total, text) {
  stepEl.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  stepEl.appendChild(span);
  dotsEl.innerHTML = Array.from({ length: total }, (_, k) => `<span class="${k === i ? 'on' : k < i ? 'done' : ''}"></span>`).join('');
}

function resetStage() {
  const W = stage.clientWidth, H = stage.clientHeight;
  stage.classList.remove('away');
  cursorEl.classList.remove('holding', 'gone');
  wheelBox.innerHTML = '';
  inkSvg.setAttribute('width', W);
  inkSvg.setAttribute('height', H);
  inkPath.setAttribute('d', '');
  return { W, H };
}

// ---------- Scrawl: hold, slide, let go, draw, put down ----------
function playScrawl() {
  const { W, H } = resetStage();
  const wk = S.hotkey, dk = S.drawKey;
  setKeys([
    { id: 'wheel', sym: wk.symbol, label: 'Wheel key' },
    { id: 'draw', sym: dk.symbol, label: 'Draw key' },
    { id: 'esc', sym: 'esc', label: 'Put down' },
  ]);
  let items = S.tools.filter((t) => t.on).map((t) => t.id);
  if (!items.includes('pencil')) items = ['pencil', ...items];
  const size = 46;
  const m = Wheel.metrics(size);
  const c = { x: Math.round(W * 0.34), y: Math.round(H * 0.5) };
  const seg = Wheel.layout(items).find((x) => x.id === 'pencil');
  const ir = (m.R + m.r) / 2;
  const pick = { x: c.x + ir * Math.cos(seg.mid), y: c.y + ir * Math.sin(seg.mid) };
  const color = S.pencilColor === '#FFFFFF' ? '#E5484D' : S.pencilColor;
  const total = 4;

  placeCursor(W * 0.8, H * 0.82);
  const tapFirst = S.wheelMode === 'double';
  say(0, total, tapFirst ? `Tap ${wk.symbol}, then tap again and hold.` : `Hold ${wk.symbol} to open the wheel.`);
  later(250, () => moveCursor(c.x, c.y, 700));
  if (tapFirst) { later(700, () => press(['wheel'], true)); later(830, () => press(['wheel'], false)); }
  later(1050, () => {
    press(['wheel'], true);
    wheelBox.innerHTML = Wheel.build({ items, size, pencilColor: color, colors: false });
    wheelBox.style.transform = `translate(${c.x - m.cx}px, ${c.y - m.cy}px)`;
    Wheel.setHover(wheelBox.querySelector('svg'), -1, items, true);
  });

  later(2300, () => { say(1, total, 'Slide to the pencil, then let go.'); moveCursor(pick.x, pick.y, 450); });
  later(2650, () => Wheel.setHover(wheelBox.querySelector('svg'), items.indexOf('pencil'), items, true));
  later(3500, () => {
    press(['wheel'], false);
    const svg = wheelBox.querySelector('svg');
    svg?.querySelector('.slice[data-id="pencil"]')?.classList.add('picked');
    svg?.classList.remove('enter');
    svg?.classList.add('leave');
    cursorEl.classList.add('holding');
    setTimeout(() => { wheelBox.innerHTML = ''; }, 200);
  });

  later(4400, () => {
    say(2, total, `Drag to draw, or hold ${dk.symbol} and move.`);
    press(['draw'], true);
    const o = { x: at.x - 10, y: at.y + 30 };
    const d = `M${o.x} ${o.y} c30 40 100 50 122 8 c15 -30 -14 -60 -36 -40 c-22 20 8 74 62 72 c34 -1 56 -24 70 -50`;
    inkPath.setAttribute('d', d);
    inkPath.style.stroke = color;
    inkPath.style.strokeWidth = Math.max(3, Math.min(S.pencilSize, 8));
    const len = inkPath.getTotalLength();
    inkPath.style.strokeDasharray = len;
    inkPath.style.strokeDashoffset = len;
    placeCursor(o.x, o.y);
    const t0 = performance.now(), dur = 2000, run = demoRun;
    const frame = (now) => {
      if (run !== demoRun) return;
      const k = Math.min(1, (now - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      inkPath.style.strokeDashoffset = len * (1 - e);
      const p = inkPath.getPointAtLength(len * e);
      placeCursor(p.x, p.y);
      if (k < 1) demoFrame = requestAnimationFrame(frame);
    };
    demoFrame = requestAnimationFrame(frame);
  });
  later(6500, () => press(['draw'], false));

  later(7200, () => { say(3, total, 'Press Esc to put the pencil down.'); press(['esc'], true); });
  later(7500, () => { press(['esc'], false); cursorEl.classList.remove('holding'); });
  later(10000, () => play());
}

// ---------- Away: press, everything blurs, press again ----------
function playAway() {
  const { W, H } = resetStage();
  const a = S.away;
  const tap = a.mode === 'double';
  const tapKeys = a.key.keys || [a.key];
  const syms = tap ? tapKeys.map((k) => k.symbol) : a.keys.symbols;
  const names = tap ? tapKeys.map((k) => k.name) : a.keys.name.split(' ');
  setKeys(syms.map((sym, i) => ({ id: `k${i}`, sym, label: names[i] || '' })));
  const all = syms.map((_, i) => `k${i}`);
  const combo = syms.join('');
  document.getElementById('stageMsg').textContent = a.message.trim() || Tools.DEFAULT_MESSAGE;
  const since = document.getElementById('stageSince');
  since.hidden = !a.showTime;
  since.textContent = `Away since ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  Tools.mood(a.mood).colors.forEach((col, i) => stage.querySelectorAll('.dblob')[i]?.style.setProperty('--c', col));
  const total = 3;

  placeCursor(W * 0.22, H * 0.7);
  // A double-tap presses the key twice; a shortcut presses its keys once.
  const twice = (at) => { if (tap) { later(at - 300, () => press(all, true)); later(at - 180, () => press(all, false)); } later(at, () => press(all, true)); };
  say(0, total, tap ? `Tap ${combo} twice to step away.` : `Press ${combo} to step away.`);
  later(200, () => moveCursor(W * 0.6, H * 0.62, 800));
  twice(1300);
  later(1400, () => stage.classList.add('away'));
  later(1750, () => press(all, false));

  later(3300, () => {
    say(1, total, a.hidePointer ? 'Your screen blurs and the pointer hides.' : 'Your screen blurs behind your note.');
    if (a.hidePointer) cursorEl.classList.add('gone');
  });

  later(5700, () => say(2, total, tap ? `Tap ${combo} twice again to come back.` : `Press ${combo} again to come back.`));
  twice(6000);
  later(6150, () => { stage.classList.remove('away'); cursorEl.classList.remove('gone'); });
  later(6500, () => press(all, false));
  later(9000, () => play());
}

function play() {
  stopDemo();
  if (demoTool === 'away') playAway();
  else playScrawl();
}

function openDemo(tool) {
  demoTool = tool;
  const t = Tools.TOOLS.find((x) => x.id === tool);
  demoEl.dataset.theme = t.theme; // the sheet wears its tool's colors
  document.getElementById('demoGlyph').innerHTML = Tools.glyph(tool, 22);
  document.getElementById('demoName').textContent = `How ${t.name} works`;
  lastFocus = document.activeElement;
  if (typeof cancelAwayListening === 'function') cancelAwayListening();
  demoEl.classList.add('open');
  document.getElementById('demoReplay').focus({ preventScroll: true });
  requestAnimationFrame(play); // measure the stage once it's on screen
}
function closeDemo() {
  if (!demoEl.classList.contains('open')) return;
  stopDemo();
  demoEl.classList.remove('open');
  lastFocus?.focus?.({ preventScroll: true });
}

document.querySelectorAll('.demo-btn').forEach((b) => b.addEventListener('click', () => openDemo(b.dataset.demo)));
document.getElementById('demoClose').addEventListener('click', closeDemo);
document.getElementById('demoReplay').addEventListener('click', play);
demoEl.addEventListener('pointerdown', (e) => { if (e.target === demoEl) closeDemo(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && demoEl.classList.contains('open')) { e.preventDefault(); closeDemo(); } });
