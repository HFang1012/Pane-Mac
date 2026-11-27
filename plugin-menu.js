// A plugin's menu: opens out of its badge. Five share rails, its own network, Focus mode, and Unplug.
// Every change goes to the main process (plugin-engine.js does the work) and comes back as the plugin's
// new state, once a second along with what the app is using right now.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (body, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24">${body}</svg>`;
const ICONS = {
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M10 2.5v3M14 2.5v3M10 18.5v3M14 18.5v3M2.5 10h3M2.5 14h3M18.5 10h3M18.5 14h3"/>',
  ram: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11v2M11 11v2M15 11v2M6 17v2.5M18 17v2.5"/>',
  net: '<path d="M8 4v14M4.5 14.5 8 18l3.5-3.5M16 20V6M12.5 9.5 16 6l3.5 3.5"/>',
  out: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  wire: '<rect x="6" y="4" width="12" height="11" rx="2"/><path d="M9.5 8v3M12 8v3M14.5 8v3M12 15v5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  home: '<path d="M4 11 12 4l8 7v8.5a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17.2v.1"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  ok: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  debug: '<path d="M4 16l4-5 4 3 4-6 4 4"/>',
  unplug: '<path d="M3 12h4"/><rect x="7" y="7" width="7" height="10" rx="2.5"/><path d="M14 10h3M14 14h3"/><path d="M19.5 6.5l-2 2M19.5 17.5l-2-2"/>',
};
const BOLT = '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const SHARES = [
  { a: 'cpu', name: 'Processor' },
  { a: 'ram', name: 'Memory' },
  { a: 'net', name: 'Network' },
  { a: 'out', name: 'Sound' },
  { a: 'mic', name: 'Microphone' },
];
const FREE = 10;

let P = null; // the plugin, as the main process last sent it
let caps = null; // { cores, mem, netSpeeds, max }
let nets = [];
let icon = null;
const levels = {}; // what the rails show (ahead of P while you drag or wait)
let dragging = null;
const pending = new Set(); // shares whose change is on its way
const open = new Set(); // shares with "how it works" open

// ---------- numbers in words ----------
const gb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(n >= 10 * 1073741824 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`);
const speed = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10 * 1048576 ? 0 : 1)} MB/s` : `${Math.round(b / 1024)} KB/s`);
const oneDp = (v) => (v > 0 && v < 0.1 ? '<0.1' : (Math.round(v * 10) / 10).toFixed(1));
const name = () => P?.name || 'this app';
const band = (L) => (L === 12 ? 'od' : L === 11 ? 'boost' : L >= 1 ? 'lim' : 'off');
const lim = (L) => L >= 1 && L < FREE; // a real limit (0 is off, 10 is all of it)

function valueText(a, L) {
  if (L === 0) return 'Off';
  if (L === FREE) return 'All of it';
  if (a === 'net' && L < FREE) return speed(caps.netSpeeds[L]);
  if ((a === 'out' || a === 'mic') && L < FREE) return `${L * 10}%`;
  if (L < FREE) return `${L} of 10`;
  if (a === 'out') return L === FREE ? '100%' : L === 11 ? '150%' : '200%';
  if (a === 'mic') return 'Full';
  if (a === 'mic' && L === 11) return 'Full';
  return L === 11 ? 'Boost' : 'Overdrive';
}

// What a share does at this level, in a sentence, with what the app is using now.
const OFF_WORD = { cpu: 'its processor', ram: 'its memory', net: 'its network', out: 'the volume', mic: 'the microphone' };
function what(a, L) {
  const l = P?.live || {}, run = P?.running;
  const cores = caps.cores, n = esc(name());
  if (L === 0) return `Off. Pane leaves ${OFF_WORD[a]} alone. Drag right to set a share.`;
  switch (a) {
    case 'cpu': {
      const now = !run ? '' : l.cpu < 0.5 ? ' Using almost none now.' : ` Using <span class="live">${oneDp(l.cpu / 10)} share${l.cpu >= 10 && l.cpu < 20 ? '' : 's'}</span> now.`;
      if (lim(L)) return `Up to <b>${(Math.round((cores * L) / 10 * 10) / 10)} of your ${cores} cores</b>.${now}`;
      if (L === FREE) return `All of it: no limit.${now}`;
      if (L === 11) return `Boost: it goes first. ${P?.quieted ? `<span class="live">${P.quieted}</span> busy part${P.quieted === 1 ? '' : 's'} of other apps stepped back.` : 'Busy apps step back while it runs.'}`;
      return `Overdrive: every other app steps back while it runs, busy or not, and your Mac stays awake.${P?.quieted ? ` <span class="live">${P.quieted}</span> parts stepped back.` : ''}`;
    }
    case 'ram': {
      const now = run ? ` Using <span class="live">${gb(l.mem)}</span>.` : '';
      if (lim(L)) return `A line at <b>${gb((L / 10) * caps.mem)}</b> of your ${gb(caps.mem)}.${now}`;
      if (L === FREE) return `All of it: no line.${now}`;
      if (L === 11) return `Boost: when you come to ${n}, other apps holding over 1.5 GB are hidden so it has room.`;
      return `Overdrive: when you come to ${n}, other apps holding over 500 MB are hidden so it has room.`;
    }
    case 'net': {
      const now = run ? ` Moving <span class="live">${speed(l.down + l.up)}</span>.` : '';
      if (lim(L)) return `Up to <b>${speed(caps.netSpeeds[L])}</b> each way${P?.routed ? ', held exactly through its own network' : ''}.${now}`;
      if (L === FREE) return `All of it: no limit.${now}`;
      return `Boost: apps moving lots of data in the background wait behind it.${now}`;
    }
    case 'out': {
      const pct = L <= FREE ? L * 10 : L === 11 ? 150 : 200;
      const snd = P?.live?.sound;
      const now = !run ? '' : !snd ? '' : snd.playing ? ' Playing now.' : ' Silent right now.';
      return `${n}’s own volume at <b>${pct}%</b>. Your Mac’s volume stays where it is.${now}`;
    }
    case 'mic':
      return '';
  }
  return '';
}
// Warnings for overuse, and the plain benefit where there's one worth saying.
function warnings(a, L) {
  const w = [];
  const W = (cls, text) => w.push({ cls, text });
  if (a === 'cpu') {
    if (L >= 1 && L <= 2) W('danger', 'This low, it can freeze for moments at a time. Calls and video will break up.');
    else if (L >= 1 && L <= 4) W('careful', 'It runs on the efficiency cores, so it may feel slower.');
    else if (lim(L)) W('good', 'Frees the rest of your Mac and keeps the fans quieter.');
    if (P?.throttle > 0.35 && lim(L)) W('careful', `Pane is pausing it ${Math.round(P.throttle * 100)}% of the time to keep it to its share.`);
    if (L === 11) W('good', 'Nothing else is limited, only asked to wait its turn.');
    if (L === 12) W('danger', 'Everything else slows down while it runs, downloads and syncs included, and your Mac won’t sleep. Best while plugged in.');
  }
  if (a === 'ram') {
    if (L >= 1 && L <= 2) W('careful', 'Most apps need more than this, so expect to hear about it.');
    else if (lim(L)) W('good', 'You’ll know before it slows the whole Mac down.');
    if (P?.over && lim(L)) W('careful', `Over its line by ${gb(P.live.mem - (L / 10) * caps.mem)}.`);
    if (L === 12) W('careful', 'Hidden apps take a moment to come back when you switch to them.');
  }
  if (a === 'net') {
    if (L >= 1 && L <= 3) W('danger', 'Pages and downloads will crawl, and calls may drop.');
    if (lim(L) && !P?.routed) W('careful', 'Held roughly, by pausing it. Give it its own network below for an exact limit.');
    if (L === 11) W('good', 'Its downloads, streams and calls get through first.');
  }
  if (a === 'out') {
    if (L === 11) W('careful', 'Louder than it plays on its own. The loudest moments are rounded off so they don’t crackle.');
    if (L === 12) W('danger', 'Twice as loud can hurt, especially in headphones. Start with your Mac’s volume low.');
    if (L > 0 && P?.live?.sound?.error) W('danger', 'macOS hasn’t let Pane hear this app yet. Allow Pane in System Settings › Privacy & Security › Screen & System Audio Recording.<br><button class="alt" data-perm="audio">Open the setting</button>');
  }
  return w;
}
// "How it works", short and plain.
const HOW = {
  cpu: 'Over its share, Pane pauses it for a split second, many times a second. At 4 or less it also runs on the slower, cooler cores. Boost and Overdrive make other apps wait.',
  ram: 'Macs can’t cap an app’s memory, so this is a line. Past it, Pane tells you, or hides the app when you leave so it uses less. Boost hides big apps when you switch to it.',
  net: 'With its own network, the speed is exact. Without one, Pane pauses it briefly when it goes over. Boost makes busy downloads in other apps wait.',
  out: 'Pane takes this app’s sound on its way to your speakers and plays it back at this volume, up to twice as loud. Other apps and your Mac’s volume aren’t touched. Off, its sound goes straight through.',
  mic: 'macOS has no way to set the microphone for one app without a virtual microphone driver, which Pane doesn’t install. So Pane leaves your microphone alone.',
};

// ---------- the rails ----------
function buildShares() {
  $('shares').innerHTML = SHARES.map((s, i) => {
    const max = caps.max[s.a];
    const cells = `<i class="cell offslot charge" data-l="0" style="--k:0" title="Off">${svg('<path d="M12 4v7"/><path d="M7.5 7.5a6 6 0 1 0 9 0"/>')}</i>` + Array.from({ length: max }, (_, k) => {
      const L = k + 1;
      if (L <= FREE) return `<i class="cell charge" data-l="${L}" style="--k:${k}"></i>`;
      return `${L === 11 ? '<span class="gap" aria-hidden="true"></span>' : ''}<i class="cell b charge" data-l="${L}" style="--k:${k + 1}" title="${L === 11 ? 'Boost' : 'Overdrive'}">${BOLT}</i>`;
    }).join('');
    return `<div class="share" data-a="${s.a}" style="--i:${i}">
      <div class="share-head" data-how="${s.a}"><span class="sic">${svg(ICONS[s.a])}</span><b>${s.name}</b><span class="use" id="nowv-${s.a}"></span><span class="val" id="val-${s.a}"></span><button class="reset" data-reset="${s.a}" title="Reset ${s.name} (off)" aria-label="Reset ${s.name}">${svg(ICONS.reset)}</button><button class="howb" aria-expanded="false" aria-controls="how-${s.a}" aria-label="How ${s.name} works">${svg(ICONS.chev, 'i chev')}</button></div>
      <div class="rail" id="rail-${s.a}" role="slider" tabindex="0" aria-label="${s.name} share" aria-valuemin="0" aria-valuemax="${max}">${cells}</div>
      ${['cpu', 'ram', 'net', 'out'].includes(s.a) ? `<div class="meter" id="meter-${s.a}" aria-hidden="true"><i class="cur"></i><b class="norm"></b></div>` : ''}
      <p class="what" id="what-${s.a}"></p>
      <div class="warns" id="warn-${s.a}"></div>
      ${s.a === 'ram' ? '<div class="picks" id="ramAct" hidden><small>Past the line:</small><button class="pick" role="radio" data-v="warn">Tell me</button><button class="pick" role="radio" data-v="hide">Hide it when I leave</button></div>' : ''}
      <div class="how" id="how-${s.a}"><div><p>${HOW[s.a]}</p></div></div>
    </div>`;
  }).join('');
  for (const s of SHARES) wireRail(s.a);
  document.querySelectorAll('[data-how]').forEach((b) => b.addEventListener('click', (e) => {
    const rb = e.target.closest('[data-reset]');
    if (rb) { resetShare(rb.dataset.reset); return; }
    const a = b.dataset.how;
    if (open.has(a)) open.delete(a); else open.add(a);
    b.closest('.share').classList.toggle('open', open.has(a));
    b.querySelector('.howb').setAttribute('aria-expanded', open.has(a));
    setTimeout(fit, 380);
  }));
  $('ramAct').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (b) send({ ramAct: b.dataset.v });
  });
}
function paintRail(a, pop = null) {
  const L = levels[a];
  const share = document.querySelector(`.share[data-a="${a}"]`);
  share.dataset.band = band(L);
  const rail = $(`rail-${a}`);
  rail.setAttribute('aria-valuenow', L);
  rail.setAttribute('aria-valuetext', valueText(a, L));
  rail.querySelectorAll('.cell').forEach((c) => {
    const k = Number(c.dataset.l);
    const cls = k === 0 ? (L === 0 ? 'isoff' : '') : k > FREE ? (k <= L ? (k === 12 ? 'od boost' : 'boost') : '') : k <= L ? 'lim' : '';
    const want = `cell${k === 0 ? ' offslot' : ''}${k > FREE ? ' b' : ''}${c.classList.contains('charge') ? ' charge' : ''}${cls ? ` ${cls}` : ''}`;
    if (c.className.replace(/ pop/g, '') !== want) {
      c.className = want;
      // Ripple out from where the level landed.
      if (pop != null) { c.style.setProperty('--dk', Math.abs(k - pop)); void c.offsetWidth; c.classList.add('pop'); }
    }
  });
  // What it's using right now, beside the setting.
  const l = P?.live, nowv = $(`nowv-${a}`) || { innerHTML: '' };
  const nm = P?.normal;
  const fmt = (x, kind) => (kind === 'cpu' ? `${x > 0 && x < 1 ? '<1' : Math.round(x)}%` : kind === 'ram' ? gb(x) : speed(x));
  // Sound: how loud it's playing (only measured while its own volume is set, since that's when Pane hears it).
  const cur = a === 'cpu' ? l?.cpu : a === 'ram' ? l?.mem : a === 'net' ? (l?.down || 0) + (l?.up || 0) : a === 'out' ? (l?.sound ? l.sound.peak : null) : null;
  const usual = a === 'cpu' ? nm?.cpu : a === 'ram' ? nm?.mem : a === 'net' ? nm?.net : null;
  const nowText = !P?.running || cur == null ? '' : a === 'out' ? `<span title="How loud it’s playing"><i class="dot"></i><b>${l.sound.playing ? `${Math.round(cur * 100)}%` : 'silent'}</b></span>` : `<span title="Using now"><i class="dot"></i><b>${fmt(cur, a)}</b></span>${usual != null ? `<span title="Usually (the last few minutes)"><i class="tick"></i><b>${fmt(usual, a)}</b></span>` : ''}`;
  if (nowv.innerHTML !== nowText) nowv.innerHTML = nowText;
  paintMeter(a, cur, usual);
  const val = $(`val-${a}`);
  const text = L === 0 ? '' : valueText(a, L); // off: the rail's power slot already says so
  if (val.textContent !== text) val.textContent = text;
  $(`what-${a}`).innerHTML = what(a, L);
  const ws = warnings(a, L);
  const wsHtml = ws.map((x) => `<div class="warn ${x.cls}">${svg(x.cls === 'good' ? ICONS.ok : ICONS.warn)}<span>${x.text}</span></div>`).join('');
  const box = $(`warn-${a}`);
  if (box.dataset.sig !== wsHtml) { box.dataset.sig = wsHtml; box.innerHTML = wsHtml; setTimeout(fit, 30); }
  share.querySelector('.reset').classList.toggle('show', L !== 0 && a !== 'mic');
  share.classList.toggle('na', a === 'mic');
  if (a === 'mic') { $(`what-${a}`).textContent = 'Not available. A microphone level for one app needs a driver Pane doesn’t install, so Pane leaves your microphone alone.'; $(`val-${a}`).textContent = ''; }
  if (a === 'ram') {
    $('ramAct').hidden = !lim(L);
    $('ramAct').querySelectorAll('.pick').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === (P?.ramAct || 'warn')));
  }
}
// The meter under a rail: what it uses now (the fill) and normally (the tick), in shares, lined up with the
// rail's ten cells. Network is on the same ladder as its speeds.
function toShares(a, x) {
  if (x == null) return null;
  if (a === 'cpu') return x / 10;
  if (a === 'ram') return (x / caps.mem) * 10;
  if (a === 'out') return x * 10;
  return x <= 1024 ? 0 : Math.log2(x / caps.netSpeeds[1]) + 1;
}
function paintMeter(a, cur, usual) {
  const m = $(`meter-${a}`);
  if (!m) return;
  const cells = [...$(`rail-${a}`).querySelectorAll('.cell')].filter((c) => { const k = Number(c.dataset.l); return k >= 1 && k <= FREE; });
  if (!cells.length || !cells[0].offsetWidth) return;
  const x0 = cells[0].offsetLeft, x1 = cells[FREE - 1].offsetLeft + cells[FREE - 1].offsetWidth;
  m.style.marginLeft = `${x0}px`;
  m.style.width = `${x1 - x0}px`;
  m.hidden = !P?.running || cur == null;
  const pct = (v) => `${Math.max(0, Math.min(10, v)) * 10}%`;
  const c = toShares(a, cur), u = toShares(a, usual);
  m.querySelector('.cur').style.width = document.body.classList.contains('filled') ? pct(c) : '0%';
  m.classList.toggle('over', lim(levels[a]) && c > levels[a]);
  const n = m.querySelector('.norm');
  n.hidden = u == null;
  if (u != null) n.style.left = pct(u);
}
function resetShare(a) {
  if (levels[a] === 0) return;
  const from = levels[a];
  levels[a] = 0;
  paintRail(a, from);
  send({ [a]: 0 }, a);
}
// Which level a point on the rail means. Dragged past the first cell, onto the off slot (or beyond the
// rail's left end), it's 0: off.
function levelAt(a, clientX) {
  const cells = [...$(`rail-${a}`).querySelectorAll('.cell')];
  if (clientX < cells[1].getBoundingClientRect().left - 1) return 0;
  for (const c of cells) { const r = c.getBoundingClientRect(); if (clientX < r.right + 1.5) return Number(c.dataset.l); }
  return Number(cells[cells.length - 1].dataset.l);
}
function wireRail(a) {
  const rail = $(`rail-${a}`);
  const max = caps.max[a];
  const share = rail.closest('.share');
  let last = null;
  const setTo = (L, commit) => {
    L = Math.max(0, Math.min(max, L));
    if (L !== levels[a]) { const from = levels[a]; levels[a] = L; paintRail(a, from); }
    if (commit) send({ [a]: L }, a);
  };
  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    rail.setPointerCapture(e.pointerId);
    dragging = a; last = levels[a];
    share.classList.add('dragging');
    setTo(levelAt(a, e.clientX), false);
  });
  rail.addEventListener('pointermove', (e) => { if (dragging === a) setTo(levelAt(a, e.clientX), false); });
  const end = () => {
    if (dragging !== a) return;
    dragging = null;
    share.classList.remove('dragging');
    if (levels[a] !== last) setTo(levels[a], true);
  };
  rail.addEventListener('pointerup', end);
  rail.addEventListener('pointercancel', end);
  rail.addEventListener('dblclick', () => setTo(0, true));
  let keyTimer = null;
  rail.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    let L = null;
    if (step) L = levels[a] + step;
    else if (e.key === 'Home') L = 0;
    else if (e.key === 'End') L = max;
    else if (e.key === 'Delete' || e.key === 'Backspace') L = 0;
    if (L == null) return;
    e.preventDefault();
    setTo(L, false);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => setTo(levels[a], true), 450);
  });
}

// ---------- own network ----------
const netIcon = (n) => (!n ? ICONS.home : /Wi-?Fi/i.test(n.name) ? ICONS.wifi : /iPhone|iPad/i.test(n.name) ? ICONS.phone : /Bridge|Thunderbolt/i.test(n.name) ? ICONS.link : ICONS.wire);
let reopenSure = null;
function renderRoute() {
  const r = P.route, can = P.chromium, n = esc(name());
  const chosen = r.device;
  const list = [{ device: null, name: 'Usual', ip: 'Your Mac’s default' }, ...nets];
  // A network you picked that's gone (unplugged, Wi-Fi off) stays in the list, so you can see what's set.
  if (chosen && !nets.some((x) => x.device === chosen)) list.push({ device: chosen, name: r.name || chosen, ip: 'Off right now' });
  const html = list.map((x, k) => `<button class="net" role="radio" aria-checked="${(x.device || null) === (chosen || null)}" data-dev="${x.device || ''}" style="--k:${k}"${can ? '' : ' disabled'}><span class="nic">${svg(netIcon(x.device ? x : null))}</span><b>${esc(x.name)}</b><small>${esc(x.ip)}</small></button>`).join('');
  // Joining a Wi-Fi network works for any app: it's your Mac's Wi-Fi that joins.
  const join = `<button class="net join" data-join="1" style="--k:${list.length}"><span class="nic">${svg(ICONS.plus)}</span><b>Join Wi-Fi</b><small>Find a network</small></button>`;
  if ($('nets').dataset.sig !== html + join) { $('nets').dataset.sig = html + join; $('nets').innerHTML = html + join; }
  const netName = esc(r.name || 'that network');
  let line = '', acts = '';
  const warns = [];
  if (!can) line = `Only apps built on Chromium can have their own network: Chrome, Brave, Edge, Arc, and apps like Discord, Slack and VS Code. ${n} isn’t one of them.`;
  else if (!chosen && !P.routed) line = 'It uses whatever network your Mac is on.';
  else if (!chosen && P.routed) {
    line = `It’s still going through Pane. Reopen it to go back to your usual network.`;
    acts = `<button class="go" data-reopen="0">Reopen ${n} normally</button>`;
  } else if (!P.routed) {
    line = P.running ? `To switch, ${n} has to reopen on <b>${netName}</b>.` : `Open ${n} from here and it starts on <b>${netName}</b>.`;
    acts = `<button class="go${reopenSure ? ' sure' : ''}" data-reopen="1">${reopenSure ? 'Click again to reopen' : P.running ? `Reopen on ${netName}` : `Open on ${netName}`}</button>`;
  } else if (!r.up) line = r.fallback ? `${netName} is off, so it’s on your usual network for now.` : `${netName} is off, so it has no connection until it’s back.`;
  else line = `Its connections leave through <b>${netName}</b>. Moving <span class="live">${speed(P.live.down + P.live.up)}</span>.`;
  if (reopenSure && P.running) warns.push(['careful', `${n} quits and opens again. It may ask you to save first.`]);
  if (chosen || P.routed) {
    warns.push(['careful', `If Pane quits, ${n} loses its connection until it reopens.`]);
    warns.push(['careful', 'Video calls may still use your usual network.']);
  }
  if (r.error) warns.push(['danger', r.error]);
  $('routeWhat').innerHTML = line;
  $('routeActs').innerHTML = acts;
  $('routeActs').hidden = !acts;
  const wh = warns.map(([c, t]) => `<div class="warn ${c}">${svg(ICONS.warn)}<span>${t}</span></div>`).join('');
  if ($('routeWarn').dataset.sig !== wh) { $('routeWarn').dataset.sig = wh; $('routeWarn').innerHTML = wh; }
  $('fallbackRow').hidden = !chosen || !can;
  $('fallback').setAttribute('aria-checked', r.fallback !== false);
  $('routeLead').textContent = P.routed && chosen ? `On ${r.name}` : 'Send it out one network';
  $('routeReset').classList.toggle('show', !!chosen || r.fallback === false);
}
$('nets').addEventListener('click', (e) => {
  const b = e.target.closest('.net');
  if (!b) return;
  if (b.dataset.join) { openWifi(); return; }
  reopenSure = null;
  const device = b.dataset.dev || null;
  if (device === (P.route.device || null)) return;
  send({ route: { device } });
});
$('routeActs').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-reopen]');
  if (!b) return;
  const routed = b.dataset.reopen === '1';
  if (P.running && !reopenSure) { reopenSure = Date.now(); renderRoute(); setTimeout(() => { if (reopenSure && Date.now() - reopenSure > 3900) { reopenSure = null; renderRoute(); } }, 4000); return; }
  reopenSure = null;
  b.classList.add('busy');
  const r = await scrawl.invoke('pmenu:reopen', routed);
  b.classList.remove('busy');
  toast(r.message, !r.ok);
});
$('routeReset').addEventListener('click', () => { reopenSure = null; send({ route: { device: null, fallback: true } }); });

// ---------- joining a Wi-Fi network ----------
// Your Mac's Wi-Fi looks for networks (Pane's helper) and joins the one you pick. With a second Wi-Fi
// adapter, or an iPhone by cable, the new network shows up above as one you can give this app.
const wifi = { busy: false, data: null, pick: null };
function bars(rssi) { const n = rssi >= -55 ? 3 : rssi >= -67 ? 2 : rssi >= -78 ? 1 : 0; return [0, 1, 2].map((k) => `<i class="${k < n ? 'on' : ''}" style="height:${4 + k * 4}px"></i>`).join(''); }
async function openWifi() {
  $('wifiPanel').hidden = false;
  fit();
  if (!wifi.data && !wifi.busy) scanWifi();
}
async function scanWifi() {
  wifi.busy = true;
  renderWifi();
  wifi.data = await scrawl.invoke('pmenu:wifiScan');
  wifi.busy = false;
  renderWifi();
}
function renderWifi() {
  const d = wifi.data;
  const notes = [];
  if (d?.error) notes.push(['danger', esc(d.error)]);
  if (d && !d.named) notes.push(['careful', 'macOS hides Wi-Fi names until Pane has Location access. Pane never reads where you are. You can still type a name below.<br><button class="alt" data-loc>Open Location settings</button>']);
  if (d && (d.wifi || []).length === 1) notes.push(['careful', 'Your Mac has one Wi-Fi card, so joining moves all of its Wi-Fi to that network. For two at once, add a USB Wi-Fi adapter or plug in your iPhone; the second one shows up above, ready to give this app.']);
  $('wifiNote').innerHTML = notes.map(([c, t]) => `<div class="warn ${c}">${svg(ICONS.warn)}<span>${t}</span></div>`).join('');
  const current = new Set((d?.wifi || []).map((w) => w.ssid).filter(Boolean));
  const named = (d?.networks || []).filter((n) => n.ssid);
  const hidden = (d?.networks || []).length - named.length;
  $('wifiList').innerHTML = wifi.busy ? '<div class="wifi-scan">Looking for networks…</div>'
    : named.map((n, k) => `<button class="wnet" role="option" aria-selected="${wifi.pick?.ssid === n.ssid}" data-ssid="${esc(n.ssid)}" data-dev="${esc(n.device)}" data-secure="${n.secure ? 1 : 0}" style="--k:${k}"><span class="bars">${bars(n.rssi)}</span><span>${esc(n.ssid)}${current.has(n.ssid) ? ' <small>Connected</small>' : ''}</span>${n.secure ? svg(ICONS.lock) : '<span></span>'}<span></span></button>`).join('')
      + (hidden && d?.named ? `<p class="what">${hidden} more without a name (hidden networks).</p>` : '');
  const showForm = !wifi.busy && !!d && (!!wifi.pick || !d.named);
  $('wifiJoin').hidden = !showForm;
  if (wifi.pick) { $('wifiName').value = wifi.pick.ssid; $('wifiName').readOnly = true; $('wifiPass').hidden = !wifi.pick.secure; }
  else { $('wifiName').readOnly = false; $('wifiPass').hidden = false; }
  $('wifiScan').disabled = wifi.busy;
  setTimeout(fit, 20);
}
$('wifiList').addEventListener('click', (e) => {
  const b = e.target.closest('.wnet');
  if (!b) return;
  wifi.pick = { ssid: b.dataset.ssid, device: b.dataset.dev, secure: b.dataset.secure === '1' };
  $('wifiPass').value = '';
  renderWifi();
  if (wifi.pick.secure) $('wifiPass').focus();
});
$('shares').addEventListener('click', (e) => { if (e.target.closest('[data-perm="audio"]')) scrawl.send('pmenu:perm', 'audio'); });
$('wifiNote').addEventListener('click', (e) => { if (e.target.closest('[data-loc]')) scrawl.send('pmenu:perm', 'location'); });
$('wifiScan').addEventListener('click', () => { wifi.pick = null; scanWifi(); });
$('wifiClose').addEventListener('click', () => { $('wifiPanel').hidden = true; wifi.pick = null; fit(); });
// Typing needs the keyboard: the menu takes it the moment you click into a field.
for (const id of ['wifiName', 'wifiPass']) $(id).addEventListener('pointerdown', () => scrawl.send('pmenu:key'));
$('wifiJoin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ssid = (wifi.pick?.ssid || $('wifiName').value).trim();
  if (!ssid) { $('wifiName').focus(); return; }
  const go = $('wifiGo');
  go.classList.add('busy');
  const r = await scrawl.invoke('pmenu:wifiJoin', { ssid, password: $('wifiPass').value, device: wifi.pick?.device || null });
  go.classList.remove('busy');
  $('wifiPass').value = '';
  toast(r.message, !r.ok);
  if (r.ok) { wifi.pick = null; wifi.data = null; $('wifiPanel').hidden = true; fit(); }
});
$('fallback').addEventListener('click', () => send({ route: { fallback: !(P.route.fallback !== false) } }));

// ---------- Focus mode ----------
const FOCUS_OPTS = [
  { k: 'blur', label: 'Blur other screens' },
  { k: 'quiet', label: 'Quiet other apps' },
  { k: 'awake', label: 'Keep Mac awake' },
  { k: 'music', label: 'Pause music' },
];
function renderFocus() {
  const f = P.focus, n = esc(name());
  $('focusTile').setAttribute('aria-pressed', f.on);
  $('focusSw').setAttribute('aria-checked', f.on);
  $('focusSub').innerHTML = !f.on ? `Everything else steps back while you’re in ${n}.` : P.focusLive ? 'On. Everything else is stepping back.' : `On. It starts when you switch to ${n}.`;
  const html = FOCUS_OPTS.map((o, k) => `<button class="fo" role="checkbox" aria-checked="${!!f[o.k]}" data-k="${o.k}" style="--k:${k}"><span class="tick">${svg(ICONS.ok)}</span>${o.label}</button>`).join('');
  $('focusOpts').hidden = !f.on;
  if ($('focusOpts').dataset.sig !== html) { $('focusOpts').dataset.sig = html; $('focusOpts').innerHTML = html; }
  const bits = [];
  if (f.on) {
    if (f.blur) bits.push('Your other screens blur over, and the desktop behind your windows. Other apps stay open where they are.');
    if (f.quiet) bits.push('Other apps keep running, unloaded into the background, so downloads and syncs in them slow down.');
    if (f.awake) bits.push('Your Mac won’t sleep while you’re in it.');
    if (f.music) bits.push('Playing music pauses, and picks up again when Focus ends.');
  }
  $('focusWhat').textContent = bits.join(' ');
  $('focusWhat').hidden = !bits.length;
  $('focusReset').classList.toggle('show', f.on || !f.blur || !f.quiet || !f.awake || f.music);
}
$('focusTile').addEventListener('click', () => send({ focus: { on: !P.focus.on } }));
$('focusReset').addEventListener('click', () => send({ focus: { on: false, blur: true, quiet: true, awake: true, music: false } }));
$('focusOpts').addEventListener('click', (e) => {
  const b = e.target.closest('.fo');
  if (b) send({ focus: { [b.dataset.k]: !P.focus[b.dataset.k] } });
});

// ---------- the rest ----------
function renderTop() {
  document.body.dataset.tone = P.status.tone;
  document.body.classList.toggle('off', !P.on);
  if ($('appName').textContent !== P.name) $('appName').textContent = P.name;
  const st = $('statusText');
  const d = P.status.detail || '';
  const text = !P.on ? 'Inactive' : !P.running ? 'Active. It starts working when the app opens.' : d && d !== 'Nothing set yet' ? `Active, ${d.charAt(0).toLowerCase()}${d.slice(1)}` : 'Active';
  if (st.textContent !== text) { st.classList.add('out'); setTimeout(() => { st.textContent = text; st.classList.remove('out'); }, 150); }
  $('power').setAttribute('aria-checked', P.on);
  $('power').setAttribute('aria-label', P.on ? 'Plugin active. Make it inactive.' : 'Plugin inactive. Make it active.');
}
function render() {
  if (!P || !caps) return;
  renderTop();
  for (const s of SHARES) {
    if (dragging !== s.a && !pending.has(s.a)) levels[s.a] = P.levels[s.a];
    paintRail(s.a);
  }
  const g = P.guarded ? `<div class="warn careful">${svg(ICONS.warn)}<span>macOS needs ${esc(P.name)}, so Pane won’t pause it or move it to the background. Its sound and Focus mode still work.</span></div>` : '';
  if ($('guard').innerHTML !== g) $('guard').innerHTML = g;
  renderRoute();
  renderFocus();
  moreBelow();
}

let busy = Promise.resolve();
function send(patch, aspect) {
  if (aspect) pending.add(aspect);
  busy = busy.then(async () => {
    const r = await scrawl.invoke('pmenu:set', patch);
    if (aspect) pending.delete(aspect);
    if (r?.plugin) P = r.plugin;
    if (r?.message) toast(r.message, !r.ok);
    render();
  });
}
let toastTimer = 0;
function toast(msg, err = false) {
  if (!msg) return;
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

let unplugSure = 0;
$('unplug').addEventListener('click', async () => {
  if (!unplugSure) {
    unplugSure = Date.now();
    $('unplug').classList.add('sure');
    $('unplugText').textContent = 'Unplug?';
    $('unplugNote').hidden = false;
    $('unplugNote').textContent = `Click Unplug? again. Everything it changed goes back${P.routed ? `, and ${name()} reopens on your usual network` : ''}.`;
    fit();
    setTimeout(() => { if (unplugSure && Date.now() - unplugSure > 3900) { unplugSure = 0; $('unplug').classList.remove('sure'); $('unplugText').textContent = ''; $('unplugNote').hidden = true; fit(); } }, 4000);
    return;
  }
  unplugSure = 0;
  $('unplug').classList.add('busy');
  const r = await scrawl.invoke('pmenu:remove');
  if (r && !r.ok) { $('unplug').classList.remove('busy', 'sure'); $('unplugText').textContent = ''; toast(r.message, true); }
});
$('power').addEventListener('click', () => send({ on: !P.on }));
$('close').addEventListener('click', () => scrawl.send('pmenu:close'));
$('debugLink').addEventListener('click', () => scrawl.send('pmenu:debug'));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('.rail, input')) scrawl.send('pmenu:close'); });

// ---------- size ----------
let fitFrame = 0;
function fit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    const w = $('wrap');
    scrawl.send('pmenu:fit', { w: w.offsetWidth, h: w.offsetHeight, ready: !!P });
    moreBelow();
  });
}
function moreBelow() {
  const b = $('body');
  b.classList.toggle('more-below', b.scrollHeight - b.scrollTop - b.clientHeight > 8);
}
$('body').addEventListener('scroll', moreBelow);
new ResizeObserver(() => fit()).observe($('card'));

scrawl.invoke('pmenu:init').then((d) => {
  P = d.plugin; caps = d.caps; nets = d.networks || []; icon = d.icon;
  document.documentElement.style.setProperty('--max', `${d.maxHeight || 720}px`);
  document.body.classList.toggle('below', !!d.below);
  $('appIc').innerHTML = `${icon ? `<img src="${icon}" alt="">` : `<span class="avatar">${esc(P.name.slice(0, 1))}</span>`}<span class="plug">${Tools.glyph('plugin', 12)}</span>`;
  buildShares();
  render();
  fit();
});
scrawl.on('pmenu:data', (v) => { if (!P || v.id !== P.id) return; P = v; render(); });
scrawl.on('pmenu:networks', (list) => { nets = list || []; if (P) renderRoute(); });
scrawl.on('pmenu:shown', () => {
  document.body.classList.add('shown');
  // The rails charge up once the card has mostly landed.
  setTimeout(() => document.body.classList.add('filled'), 300);
  setTimeout(() => document.querySelectorAll('.cell.charge').forEach((c) => c.classList.remove('charge')), 1400);
});
scrawl.on('pmenu:leave', () => {
  document.body.classList.add('leaving');
  setTimeout(() => scrawl.send('pmenu:gone'), 230);
});
