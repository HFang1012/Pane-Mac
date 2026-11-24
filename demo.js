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
  since.textContent = 'Away for 12 min';
  document.getElementById('stageCup').innerHTML = Tools.glyph('away', 26, { icon: a.icon, mood: a.mood });
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

// ---------- shared bits for the other tools ----------
const layer = document.getElementById('stageLayer');
const PLANE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 3.5 10.6 13.4"/><path d="M20.5 3.5 14.2 20.5l-3.6-7.1-7.1-3.6z"/></svg>';
function add(html, x, y) {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  const el = t.firstElementChild;
  if (x != null) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
  layer.appendChild(el);
  return el;
}
const out = (el) => { el?.classList.add('dl-out'); setTimeout(() => el?.remove(), 220); };
// How a tool is opened, as keys for the demo: a double-tap of one key, a key held down, or a shortcut.
// `how` is 'double' | 'hold' | 'shortcut'.
function openKeys(t, label) {
  const how = t.mode === 'double' ? 'double' : t.mode === 'hold' ? 'hold' : 'shortcut';
  const list = how === 'shortcut' ? t.keys.symbols.map((sym, i) => ({ sym, name: t.keys.name.split(' ')[i] || '' })) : (t.key.keys || [t.key]).map((k) => ({ sym: k.symbol, name: label }));
  const keys = list.map((k, i) => ({ id: `k${i}`, sym: k.sym, label: how === 'shortcut' ? k.name : k.name }));
  const ids = keys.map((k) => k.id);
  const combo = list.map((k) => k.sym).join('');
  const verb = how === 'double' ? `Tap ${combo} twice` : how === 'hold' ? `Hold ${combo}` : `Press ${combo}`;
  // Press them the way that opens the tool, landing on `at` ms.
  const go = (at) => {
    if (how === 'double') { later(at - 300, () => press(ids, true)); later(at - 180, () => press(ids, false)); }
    later(at, () => press(ids, true));
    later(at + (how === 'hold' ? 600 : 220), () => press(ids, false));
  };
  return { how, keys, ids, combo, verb, go, wait: how === 'hold' ? 600 : 0 };
}
// A sentence's first letter in capitals, for steps that start with a verb.
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---------- Spin: hold, slide to Next, let go; back to the middle cancels ----------
function playSpin() {
  const { W, H } = resetStage();
  const sp = S.spin;
  const k = sp.key;
  setKeys([{ id: 'spin', sym: k.symbol, label: k.side ? `Spin key (${k.side})` : 'Spin key' }]);
  const layout = sp.wheel.filter((x) => x.on).map((x) => x.id);
  const size = 46;
  const m = Spin.metrics(size, true);
  const songs = [{ title: 'Sunday Drive', artist: 'The Lanterns' }, { title: 'Paper Moons', artist: 'Juno Park' }];
  const np = (i) => ({ state: 'playing', track: { id: `s${i}`, ...songs[i] } });
  const c = { x: Math.round(W * 0.56), y: Math.round(H * 0.46) };
  const spot = (id) => {
    const a = Spin.sliceMid(Spin.SLICE[id], layout);
    const ir = (m.R + m.r) / 2;
    return a == null ? c : { x: c.x + ir * Math.cos(a), y: c.y + ir * Math.sin(a) };
  };
  const target = layout.includes('next') ? 'next' : layout[0];
  const name = { next: 'Next', prev: 'Previous', play: 'Play', volume: 'Volume', lists: 'Playlists' }[target];
  const other = layout.find((id) => id !== target) || target;
  const now = add(`<div class="sp-now"><span class="disc" style="--c:${Spin.labelColor(songs[0])}"></span><span class="t"><b>${songs[0].title}</b><small>${songs[0].artist}</small></span></div>`);
  const setSong = (i) => {
    now.querySelector('.disc').style.setProperty('--c', Spin.labelColor(songs[i]));
    const t = now.querySelector('.t');
    t.innerHTML = `<b>${songs[i].title}</b><small>${songs[i].artist}</small>`;
    t.classList.remove('swap'); void t.offsetWidth; t.classList.add('swap');
  };
  const tapFirst = sp.mode === 'double';
  const open = (at, song) => {
    if (tapFirst) { later(at - 350, () => press(['spin'], true)); later(at - 220, () => press(['spin'], false)); }
    later(at, () => {
      press(['spin'], true);
      wheelBox.innerHTML = Spin.build({ size, np: np(song), compact: true, layout });
      wheelBox.style.transform = `translate(${c.x - m.cx}px, ${c.y - m.cy}px)`;
      Spin.setHover(wheelBox.querySelector('svg'), -1, { np: np(song), size, layout });
    });
  };
  const hover = (id, song) => Spin.setHover(wheelBox.querySelector('svg'), id == null ? -1 : Spin.SLICE[id], { np: np(song), size, layout });
  const close = (at, picked) => later(at, () => {
    press(['spin'], false);
    const svg = wheelBox.querySelector('svg');
    if (picked) svg?.querySelector(`.slice[data-id="${picked}"]`)?.classList.add('picked');
    svg?.classList.remove('enter'); svg?.classList.add('leave');
    setTimeout(() => { wheelBox.innerHTML = ''; }, 200);
  });
  const total = 4;

  placeCursor(W * 0.85, H * 0.8);
  say(0, total, tapFirst ? `Tap ${k.symbol}, then tap again and hold.` : `Hold ${k.symbol} to open the music wheel.`);
  later(250, () => moveCursor(c.x, c.y, 700));
  open(1100, 0);
  later(2300, () => { say(1, total, `Slide to ${name}, then let go.`); const p = spot(target); moveCursor(p.x, p.y, 450); });
  later(2700, () => hover(target, 0));
  close(3500, target);
  later(3600, () => { say(2, total, target === 'next' ? 'The next song plays.' : `${name} happens.`); if (target === 'next') setSong(1); });
  later(5400, () => say(3, total, 'Changed your mind? Slide back to the middle.'));
  open(5900, 1);
  later(6400, () => { const p = spot(other); moveCursor(p.x, p.y, 420); });
  later(6800, () => hover(other, 1));
  later(7300, () => { moveCursor(c.x, c.y, 380); });
  later(7600, () => hover(null, 1));
  close(8200, null);
  later(10500, () => play());
}

// ---------- Jot: open a note, type, pick a timer, send it; it comes back ----------
function playJot() {
  const { W, H } = resetStage();
  const j = S.jot;
  const o = openKeys(j, 'Jot key');
  setKeys([...o.keys, { id: 'send', sym: '⌘↩', label: 'Send' }]);
  const total = 4;
  const p = { x: Math.round(W * 0.36), y: Math.round(H * 0.28) };
  const text = 'Call the dentist back';
  const pills = [5, 10, 15, 30, 60];
  const pick = pills.includes(j.last) ? j.last : 15;
  let note = null;

  placeCursor(W * 0.8, H * 0.78);
  say(0, total, `${o.verb} to open a note.`);
  later(200, () => moveCursor(p.x, p.y, 750));
  o.go(1300);
  later(1350 + o.wait, () => {
    note = add(`<div class="sj-note dl-pop"><div class="grip"><span></span></div><div class="txt"></div><div class="pills">${pills.map((n) => `<i data-n="${n}">${n < 60 ? `${n}m` : '1h'}</i>`).join('')}</div><span class="send">${PLANE}</span></div>`, p.x - 14, p.y + 6);
  });
  later(2200 + o.wait, () => {
    say(1, total, 'Write what to remember.');
    const box = note?.querySelector('.txt');
    [...text].forEach((ch, i) => later(i * 55, () => { if (box) box.textContent += ch; }));
  });
  later(3800 + o.wait, () => {
    say(2, total, `Pick when it comes back: ${pick < 60 ? `${pick} min` : '1 hr'}.`);
    const pill = note?.querySelector(`[data-n="${pick}"]`);
    if (pill) { const r = pill.getBoundingClientRect(), s = stage.getBoundingClientRect(); moveCursor(r.left - s.left + r.width / 2, r.top - s.top + r.height / 2, 450); }
  });
  later(4400 + o.wait, () => note?.querySelector(`[data-n="${pick}"]`)?.classList.add('on'));
  later(5300 + o.wait, () => { say(3, total, 'Press ⌘↩ to send it. It comes back when it’s time.'); press(['send'], true); });
  later(5500 + o.wait, () => {
    press(['send'], false);
    if (!note) return;
    const r = note.getBoundingClientRect(), s = stage.getBoundingClientRect();
    note.classList.add('sent');
    add(`<div class="sj-plane">${PLANE}</div>`, r.right - s.left - 30, r.bottom - s.top - 30);
    setTimeout(() => note?.remove(), 450);
  });
  later(7300 + o.wait, () => add(`<div class="sj-back"><span class="bell"></span><div><b>Time’s up</b><small>${text}</small></div></div>`));
  later(10500 + o.wait, () => play());
}

// ---------- Tweak: point at files, click one, the editor opens, crop, save ----------
function playTweak() {
  const { W, H } = resetStage();
  stage.classList.add('calm');
  const t = S.tweak;
  const o = openKeys(t, 'Tweak key');
  setKeys([...o.keys, { id: 'esc', sym: 'esc', label: 'Put away' }]);
  const files = [
    add('<div class="st-file photo"><span></span>photo.heic</div>', 40, 30),
    add('<div class="st-file clip"><span></span>clip.mov</div>', 40, 130),
    add('<div class="st-file text"><span></span>notes.md</div>', 128, 30),
  ];
  const mark = add('<div class="st-mark"></div>', 0, 0);
  const at = (el) => ({ x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + 22 });
  const ring = (el) => { mark.style.transform = `translate(${el.offsetLeft - 5}px, ${el.offsetTop - 6}px)`; };
  const total = 4;

  placeCursor(W * 0.6, H * 0.75);
  say(0, total, `${o.verb} to start pointing.`);
  o.go(1100);
  later(1200 + o.wait, () => { say(1, total, 'Point at a file on your desktop or in Finder.'); ring(files[2]); mark.classList.add('on'); const p = at(files[2]); moveCursor(p.x + 6, p.y + 4, 600); });
  later(2300 + o.wait, () => { ring(files[1]); const p = at(files[1]); moveCursor(p.x + 6, p.y + 4, 600); });
  later(3300 + o.wait, () => { ring(files[0]); const p = at(files[0]); moveCursor(p.x + 6, p.y + 4, 600); });
  let ed = null;
  later(4300 + o.wait, () => {
    say(2, total, 'Click it to open it right there.');
    mark.classList.remove('on');
    ed = add('<div class="st-ed dl-pop"><div class="tb"><i></i><i></i><i></i></div><div class="pic"><div class="crop"></div></div><div class="side"><i></i><i></i><i></i><i></i></div><b class="save">Save</b></div>', Math.round(W * 0.42), 34);
  });
  later(5300 + o.wait, () => { say(3, total, 'Crop, trim or rewrite it, then Save.'); ed?.querySelector('.crop')?.classList.add('in'); const s = ed?.querySelector('.save'); if (s) moveCursor(ed.offsetLeft + s.offsetLeft + s.offsetWidth / 2, ed.offsetTop + s.offsetTop + s.offsetHeight / 2, 700); });
  later(6600 + o.wait, () => ed?.querySelector('.save')?.classList.add('down'));
  later(6750 + o.wait, () => ed?.querySelector('.save')?.classList.remove('down'));
  later(7100 + o.wait, () => out(ed));
  later(9500 + o.wait, () => play());
}

// ---------- Debug: open the panel, see what's wrong, click the fix ----------
function playDebug() {
  const { W, H } = resetStage();
  stage.classList.add('calm');
  const o = openKeys(S.debug, 'Debug key');
  setKeys(o.keys);
  const total = 3;
  const p = { x: Math.round(W * 0.3), y: Math.round(H * 0.06) };
  let panel = null;
  const rings = [12, 45, 22, 60];

  placeCursor(W * 0.75, H * 0.75);
  say(0, total, `${o.verb} to open Debug.`);
  later(200, () => moveCursor(p.x + 100, p.y - 4, 700));
  o.go(1300);
  later(1350 + o.wait, () => {
    panel = add(`<div class="sd-panel bad dl-pop"><div class="top">${Tools.glyph('debug', 14)}Debug</div>
      <div class="v"><span></span><b>Chrome is working hard</b></div>
      <div class="rings">${rings.map(() => '<svg viewBox="0 0 40 40"><circle class="t" cx="20" cy="20" r="15"/><circle class="val" cx="20" cy="20" r="15" pathLength="100" stroke-dashoffset="100"/></svg>').join('')}</div>
      <div class="fix">88% of your Mac <b>Quit Chrome</b></div></div>`, p.x, p.y + 10);
    requestAnimationFrame(() => panel?.querySelectorAll('.val').forEach((c, i) => c.setAttribute('stroke-dashoffset', i ? rings[i] : 8)));
  });
  later(2700 + o.wait, () => {
    say(1, total, 'It shows what’s slowing your Mac down, and a fix.');
    const b = panel?.querySelector('.fix b');
    if (b) moveCursor(panel.offsetLeft + b.offsetLeft + b.offsetWidth / 2, panel.offsetTop + b.offsetTop + b.offsetHeight / 2, 700);
  });
  later(4300 + o.wait, () => { say(2, total, 'Click the fix. It asks first if anything could be lost.'); panel?.querySelector('.fix b')?.classList.add('down'); });
  later(4450 + o.wait, () => panel?.querySelector('.fix b')?.classList.remove('down'));
  later(4800 + o.wait, () => {
    if (!panel) return;
    panel.classList.remove('bad');
    panel.querySelector('.fix').classList.add('gone');
    const v = panel.querySelector('.v b');
    v.textContent = 'Running smoothly'; v.classList.add('swap');
    panel.querySelector('.val').setAttribute('stroke-dashoffset', 80);
  });
  later(8200 + o.wait, () => play());
}

const PLAYERS = { away: playAway, spin: playSpin, jot: playJot, tweak: playTweak, debug: playDebug };
function play() {
  stopDemo();
  layer.innerHTML = '';
  stage.classList.remove('calm');
  (PLAYERS[demoTool] || playScrawl)();
}

// ---------- Scrawl's card: the wheel opens, the pencil is picked, a line is drawn. On a loop. ----------
// Like the other tools' little desks, it holds still while you're working in another app (html.idle)
// or looking at another tool's page.
(function scrawlDesk() {
  const desk = document.getElementById('sdesk');
  if (!desk) return;
  const cur = desk.querySelector('.scur');
  const wheel = document.getElementById('sdeskWheel');
  const ink = document.getElementById('sdeskInk');
  document.getElementById('sdeskChip').innerHTML = Wheel.icon('pencil', 12);
  let pos = { x: 380, y: 170 };
  const put = (x, y) => { pos = { x, y }; cur.getAnimations().forEach((a) => a.cancel()); cur.style.transform = `translate(${x}px, ${y}px)`; };
  const glide = (x, y, ms) => { const f = pos; put(x, y); cur.animate([{ transform: `translate(${f.x}px, ${f.y}px)` }, { transform: `translate(${x}px, ${y}px)` }], { duration: ms, easing: 'cubic-bezier(.45,.05,.25,1)' }); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = () => !document.documentElement.classList.contains('idle') && !desk.closest('[hidden]') && !document.hidden;
  // At rest (before the first run, or held still): the pointer sits in the corner of the desk, no line.
  put(380, 170);
  ink.style.opacity = 0;
  async function loop() {
    while (true) {
      if (!S || !visible()) { await wait(600); continue; }
      let items = S.tools.filter((t) => t.on).map((t) => t.id);
      if (!items.includes('pencil')) items = ['pencil', ...items];
      const color = S.pencilColor === '#FFFFFF' ? '#E5484D' : S.pencilColor;
      const size = 34, m = Wheel.metrics(size);
      const c = { x: 150, y: 100 };
      const seg = Wheel.layout(items).find((x) => x.id === 'pencil');
      const ir = (m.R + m.r) / 2;
      const pick = { x: c.x + ir * Math.cos(seg.mid), y: c.y + ir * Math.sin(seg.mid) };
      desk.style.setProperty('--ink-c', color);
      ink.style.transition = 'none'; ink.style.strokeDashoffset = 1; ink.style.opacity = 0;
      cur.classList.remove('holding');
      put(380, 170);
      await wait(400); glide(c.x, c.y, 800); await wait(900);
      wheel.innerHTML = Wheel.build({ items, size, pencilColor: color, colors: false });
      wheel.style.transform = `translate(${c.x - m.cx}px, ${c.y - m.cy}px)`;
      Wheel.setHover(wheel.querySelector('svg'), -1, items, true);
      await wait(700); glide(pick.x, pick.y, 450); await wait(350);
      Wheel.setHover(wheel.querySelector('svg'), items.indexOf('pencil'), items, true);
      await wait(600);
      const svg = wheel.querySelector('svg');
      svg?.querySelector('.slice[data-id="pencil"]')?.classList.add('picked');
      svg?.classList.remove('enter'); svg?.classList.add('leave');
      cur.classList.add('holding');
      await wait(200); wheel.innerHTML = '';
      // Draw: the line starts where the pointer is and the pointer rides along it.
      const start = ink.getPointAtLength(0);
      glide(start.x, start.y, 400); await wait(450);
      ink.style.opacity = 1; // (only now: a hidden line's round cap would still show as a dot)
      const len = ink.getTotalLength(), t0 = performance.now(), dur = 1800;
      await new Promise((done) => {
        const step = (now) => {
          const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          ink.style.strokeDashoffset = 1 - e;
          const p = ink.getPointAtLength(len * e);
          put(p.x, p.y);
          if (k < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
      await wait(700); cur.classList.remove('holding');
      await wait(1400); ink.style.transition = 'opacity 400ms ease'; ink.style.opacity = 0;
      await wait(700);
    }
  }
  loop();
}());

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
