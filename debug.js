// Debug's panel. The main process sends a fresh look at the Mac every couple of seconds (debug-stats.js);
// this page turns it into a verdict anyone can read, four gauges, a little graph, and fixes to click.
// It looks at one app (the one you were in, to start) or the whole Mac.
const $ = (id) => document.getElementById(id);
let cfg = null; // settings.debug
let snap = null; // the latest look
let view = 'app'; // 'app' | 'mac'
let appKey = null; // which app, by its key (bundle id, or 'macos')
let frontKey = null; // the app you were in when Debug opened
let selfPid = 0;
let picking = false;
let mini = false;
let showAll = false;
const dismissed = new Set(); // fixes already run: hidden until the problem goes away and comes back
const running = new Set(); // fixes running right now

// ---------- little helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function bytes(n) {
  if (!(n > 0)) return '0 MB';
  const gb = n / 1073741824;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
  return `${Math.max(1, Math.round(n / 1048576))} MB`;
}
function duration(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
}
function days(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}`;
  if (h >= 1) return `${h} hr${h === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(sec / 60))} min`;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const recent = (a, n = 3) => avg((a || []).slice(-n));
const short = (name) => name.replace(/^Google /, '').replace(/^Microsoft /, '');
const appByKey = (k) => snap?.apps.find((a) => a.key === k);
const ICON = {
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 6v7"/><path d="M12 17.5v.5"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><path d="M12 6v7"/><path d="M12 17.5v.5"/></svg>',
  tip: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
};
const FACE = {
  good: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 6v7"/><path d="M12 17.5v.5"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><path d="M12 6v7"/><path d="M12 17.5v.5"/></svg>',
};
function appIcon(a, cls = 'appic') {
  if (a?.system) return '<svg class="macic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/></svg>';
  if (a?.icon) return `<img class="${cls}" src="${a.icon}" alt="">`;
  const hue = [...(a?.name || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<span class="avatar" style="background:hsl(${hue} 32% 48%)">${esc((a?.name || '?')[0])}</span>`;
}
// Good, keep an eye on it, or a problem.
const lvl = (v, warn, bad) => (v >= bad ? 'bad' : v >= warn ? 'warn' : 'good');

// ---------- what's wrong, and what to do about it ----------
// Each suggestion: { id, level: 'bad' | 'warn' | 'tip', title, why, acts: [{ label, kind, app, confirm, calm }] }
// `kind` is a fix the main process knows by name (see debug-stats.js), or 'view' to look at an app.
const quitAct = (a, label = `Quit ${short(a.name)}`) => ({ label, kind: 'quit', app: a, confirm: cfg?.confirm ? `${short(a.name)} may ask you to save first.` : null });
const lookAct = (a) => ({ label: 'Look closer', kind: 'view', app: a, calm: true });
const hot = (a) => recent(a.history) >= 20 || (recent(a.history) * (snap?.cores || 8)) >= 85;

function macSuggestions(s) {
  const out = [];
  const apps = s.apps.filter((a) => !a.self && !a.system);
  const onBattery = s.battery && !s.battery.plugged;
  // Apps working hard: the biggest drain on speed and battery.
  for (const a of apps.filter(hot).slice(0, 2)) {
    const share = Math.round(recent(a.history));
    const stuck = share < 20; // one core flat out: often an app stuck in a loop
    out.push({
      id: `hot:${a.key}`, level: share >= 40 ? 'bad' : 'warn',
      title: `${short(a.name)} is working hard`,
      why: stuck ? `It’s been running one of your Mac’s cores flat out. If it seems stuck, quitting it helps.`
        : `It’s using ${share}% of your Mac’s power${onBattery ? ', which drains your battery fast' : ', which can slow everything else down'}.`,
      acts: [quitAct(a), lookAct(a)],
    });
  }
  // macOS itself busy: usually something that finishes on its own.
  const sys = s.apps.find((a) => a.system);
  for (const p of (sys?.parts || []).filter((p) => p.label && p.core >= 60).slice(0, 1)) {
    const screen = p.name === 'WindowServer';
    out.push({
      id: `sys:${p.name}`, level: 'tip',
      title: screen ? 'Drawing the screen is taking a lot of work' : `${p.label} is busy`,
      why: screen ? 'Lots of open windows, a big external display or see-through effects all add up. Closing windows you don’t need helps.'
        : `${p.label} ${p.about}. It finishes on its own, so it’s fine to wait.`,
      acts: screen ? [{ label: 'Reduce motion & transparency', kind: 'open:display', calm: true }] : [],
    });
  }
  // Memory.
  const heavy = [...apps].sort((a, b) => b.mem - a.mem)[0];
  if (s.mem.pressure !== 'normal') {
    out.push({
      id: 'mem', level: s.mem.pressure === 'critical' ? 'bad' : 'warn',
      title: 'Memory is running low',
      why: 'Your Mac is squeezing apps into too little room, which makes everything slower. Quitting an app you’re not using frees some up.',
      acts: heavy ? [quitAct(heavy, `Quit ${short(heavy.name)} (frees about ${bytes(heavy.mem)})`), lookAct(heavy)] : [],
    });
  }
  const swapBig = s.mem.swapUsed > Math.max(2 * 1073741824, s.mem.total * 0.15);
  if (swapBig) {
    out.push({
      id: 'swap', level: 'warn',
      title: 'Your Mac is using storage as memory',
      why: `${bytes(s.mem.swapUsed)} has spilled over onto your storage, which is much slower than memory. A restart clears it out.`,
      acts: [{ label: 'Restart…', kind: 'restart' }],
    });
  } else if (s.uptime > 7 * 86400) {
    out.push({
      id: 'uptime', level: 'tip',
      title: `It’s been ${days(s.uptime)} since a restart`,
      why: 'Restarting now and then clears out memory leaks and stuck background tasks.',
      acts: [{ label: 'Restart…', kind: 'restart', calm: true }],
    });
  }
  // Storage.
  if (s.disk) {
    const pct = (s.disk.free / s.disk.total) * 100;
    if (pct < 10 || s.disk.free < 20e9) {
      out.push({
        id: 'disk', level: pct < 5 || s.disk.free < 10e9 ? 'bad' : 'warn',
        title: 'Storage is almost full',
        why: `Only ${bytes(s.disk.free)} left. Your Mac needs free space to run smoothly and install updates.`,
        acts: [{ label: 'Empty Trash', kind: 'trash', confirm: 'Everything in the Trash is deleted for good.' }, { label: 'See what’s using it', kind: 'open:storage', calm: true }],
      });
    }
  }
  // Battery.
  const b = s.battery;
  if (b) {
    const drain = apps.filter((a) => !a.self)[0];
    if (!b.plugged && b.pct <= 20) {
      out.push({
        id: 'batt-low', level: b.pct <= 10 ? 'bad' : 'warn',
        title: 'Battery is low',
        why: `${b.pct}% left${b.remaining ? `, about ${duration(b.remaining)}` : ''}. Low Power Mode makes it last longer.`,
        acts: [{ label: 'Battery settings', kind: 'open:battery', calm: true }],
      });
    } else if (!b.plugged && b.remaining != null && b.remaining < 150 && drain && recent(drain.history) > 4) {
      out.push({
        id: 'batt-drain', level: 'warn',
        title: 'Battery is draining fast',
        why: `About ${duration(b.remaining)} left. ${short(drain.name)} is using the most power.`,
        acts: [quitAct(drain), { label: 'Battery settings', kind: 'open:battery', calm: true }],
      });
    }
    if (b.failing || (b.health != null && b.health < 80)) {
      out.push({
        id: 'batt-health', level: 'tip',
        title: 'Your battery is wearing out',
        why: b.health != null ? `It holds ${b.health}% of the charge it did when new${b.cycles ? `, after ${b.cycles} charges` : ''}. That’s why it runs out sooner.` : 'macOS says it needs a check.',
        acts: [{ label: 'Battery health', kind: 'open:battery', calm: true }],
      });
    }
    if (onBattery) {
      const awake = apps.find((a) => a.awake.length);
      if (awake) {
        out.push({
          id: `awake:${awake.key}`, level: 'tip',
          title: `${short(awake.name)} is keeping your Mac awake`,
          why: `It’s asked macOS not to sleep (${esc(awake.awake[0])}). Your screen and battery stay on while it does.`,
          acts: [quitAct(awake)],
        });
      }
    }
  }
  if (s.heat?.throttled) {
    const top = apps.filter(hot)[0];
    out.push({
      id: 'heat', level: 'bad',
      title: 'Your Mac is hot and slowing itself down',
      why: 'It runs slower to cool off. Quit busy apps and give it room to breathe (not on a blanket or pillow).',
      acts: top ? [quitAct(top)] : [],
    });
  }
  return out;
}

function appSuggestions(s, a) {
  const out = [];
  if (a.system) {
    for (const p of (a.parts || []).filter((p) => p.core >= 50).slice(0, 2)) {
      out.push({
        id: `sys:${p.name}`, level: 'tip',
        title: p.label ? `${p.label} is busy` : `${p.name} is busy`,
        why: p.label ? `${p.label} ${p.about}. It finishes on its own.` : 'It’s part of macOS. If it stays busy for a long time, a restart usually settles it.',
        acts: [],
      });
    }
    if (!out.length && recent(a.history) >= 25) out.push({ id: 'sys-busy', level: 'tip', title: 'macOS is busy in the background', why: 'Updates, backups and indexing run when they can. A restart helps if it never calms down.', acts: [{ label: 'Restart…', kind: 'restart', calm: true }] });
    return out;
  }
  const share = Math.round(recent(a.history));
  const onBattery = s.battery && !s.battery.plugged;
  if (hot(a)) {
    out.push({
      id: `hot:${a.key}`, level: share >= 40 ? 'bad' : 'warn',
      title: share >= 20 ? `${short(a.name)} is working hard` : `${short(a.name)} may be stuck`,
      why: share >= 20 ? `It’s using ${share}% of your Mac’s power${onBattery ? ' and draining your battery' : ''}. Quitting it frees that up.`
        : 'It’s been running one core flat out. If it isn’t responding, force it to quit.',
      acts: [quitAct(a), ...(share < 20 ? [{ label: 'Force quit', kind: 'force', app: a, confirm: 'Anything you haven’t saved is lost.' }] : [])],
    });
  }
  if (a.mem > Math.max(2 * 1073741824, s.mem.total * 0.15)) {
    out.push({
      id: `mem:${a.key}`, level: s.mem.pressure !== 'normal' || a.mem / s.mem.total >= 0.25 ? 'warn' : 'tip',
      title: `${short(a.name)} is using a lot of memory`,
      why: `About ${bytes(a.mem)}. Apps build up memory over time. Reopening it starts it fresh.`,
      acts: [{ label: `Reopen ${short(a.name)}`, kind: 'reopen', app: a, confirm: cfg?.confirm ? 'It quits, then opens again.' : null }],
    });
  }
  if (BROWSERS.includes(a.bundle)) {
    out.push({
      id: `tabs:${a.key}`, level: 'tip',
      title: 'Lots of tabs?',
      why: `Every tab uses memory, even ones you can’t see. ${CHROMIUM.includes(a.bundle) ? `To find the one that’s busiest, open Window › Task Manager in ${short(a.name)}.` : 'Closing ones you’re done with helps.'}`,
      acts: [{ label: 'Close duplicate tabs', kind: 'tabs', app: a, confirm: 'Tabs showing a page that’s already open in another tab will close.' }],
    });
  }
  if (a.awake.length) {
    out.push({
      id: `awake:${a.key}`, level: 'tip',
      title: 'It’s keeping your Mac awake',
      why: `${short(a.name)} asked macOS not to sleep (${esc(a.awake[0])}).${onBattery ? ' That uses battery.' : ''}`,
      acts: [],
    });
  }
  return out;
}
const CHROMIUM = ['com.google.Chrome', 'com.google.Chrome.beta', 'com.brave.Browser', 'com.microsoft.edgemac', 'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera'];
const BROWSERS = [...CHROMIUM, 'com.apple.Safari'];

// ---------- drawing ----------
// One gauge: how full its ring is (0-100), its name, a word under it, its color, and what sits in the middle.
const ring = (value, label, word, level, center = '') => ({ v: Math.max(0, Math.min(100, value)), label, word, level, center });
const pct = (v) => `${v > 0 && v < 1 ? '<1' : Math.round(v)}%`;
function tilesFor(s, a) {
  if (a) {
    const share = recent(a.history, 2);
    const memPct = (a.mem / s.mem.total) * 100;
    const energy = recent(a.history) >= 25 ? 'High' : recent(a.history) >= 6 ? 'Medium' : 'Low';
    return [
      ring(share, 'Processor', share >= 35 ? 'Working hard' : share >= 10 ? 'Busy' : 'Calm', lvl(share, 15, 35), pct(share)), // a full ring is the whole Mac
      ring(memPct, 'Memory', bytes(a.mem), lvl(memPct, 12, 25), pct(memPct)), // a full ring is all of its memory
      ring({ Low: 18, Medium: 55, High: 92 }[energy], 'Energy', energy, { Low: 'good', Medium: 'warn', High: 'bad' }[energy], iconFor('Energy')),
      ring(Math.min(100, a.procs * 3), a.system ? 'Tasks' : 'Parts', `${a.procs} running`, 'good', iconFor('Parts')),
    ];
  }
  const b = s.battery;
  const memPct = (s.mem.used / s.mem.total) * 100;
  const tiles = [
    ring(s.cpu.total, 'Processor', s.cpu.total >= 70 ? 'Maxed out' : s.cpu.total >= 35 ? 'Busy' : 'Calm', lvl(s.cpu.total, 45, 80), pct(s.cpu.total)),
    ring(memPct, 'Memory', { normal: 'Plenty', warn: 'Tight', critical: 'Full' }[s.mem.pressure], { normal: 'good', warn: 'warn', critical: 'bad' }[s.mem.pressure], pct(memPct)),
  ];
  if (b) {
    const word = b.charging ? 'Charging' : b.full || (b.plugged && b.pct >= 99) ? 'Full' : b.plugged ? 'Plugged in' : b.remaining ? `${duration(b.remaining)}` : 'On battery';
    tiles.push(ring(b.pct, 'Battery', word, b.plugged ? 'good' : b.pct <= 10 ? 'bad' : b.pct <= 20 ? 'warn' : 'good', pct(b.pct)));
  } else {
    tiles.push(ring(Math.min(100, (s.uptime / (7 * 86400)) * 100), 'Running', days(s.uptime), s.uptime > 14 * 86400 ? 'warn' : 'good', iconFor('Running')));
  }
  if (s.disk) {
    const used = 100 - (s.disk.free / s.disk.total) * 100;
    tiles.push(ring(used, 'Storage', `${bytes(s.disk.free)} free`, used >= 95 ? 'bad' : used >= 90 ? 'warn' : 'good', pct(used)));
  }
  return tiles;
}
function tileHTML(t, i) {
  return `<div class="tile ${t.level}" style="animation-delay:${i * 40}ms">
    <div class="ring"><svg viewBox="0 0 46 46"><circle class="track" cx="23" cy="23" r="19"/><circle class="val" cx="23" cy="23" r="19" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100 - t.v}"/></svg><span>${t.center}</span></div>
    <b>${t.label}</b><small>${esc(t.word)}</small></div>`;
}
function iconFor(label) {
  const p = {
    Energy: '<path d="M13 3 6 13h5l-1 8 7-10h-5z"/>',
    Parts: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    Tasks: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    Running: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  }[label];
  return p ? `<svg class="i" viewBox="0 0 24 24" style="width:15px;height:15px">${p}</svg>` : '';
}
// Update the gauges in place, so the rings glide to their new values instead of popping.
function renderTiles(tiles) {
  const box = $('tiles');
  if (box.children.length !== tiles.length || box.dataset.view !== `${view}:${appKey}`) {
    box.dataset.view = `${view}:${appKey}`;
    box.innerHTML = tiles.map(tileHTML).join('');
    return;
  }
  tiles.forEach((t, i) => {
    const el = box.children[i];
    el.className = `tile ${t.level}`;
    el.querySelector('.val').setAttribute('stroke-dashoffset', 100 - t.v);
    const mid = el.querySelector('.ring span');
    if (/^<?\d+%$/.test(t.center) && /%$/.test(mid.textContent)) {
      // Same kind of number: count to it. (`<1%` arrives escaped-free here, as plain text.)
      if (mid.__target !== t.center) { mid.__target = t.center; mid.__shown ??= Number.parseInt(mid.textContent.replace('<', ''), 10) || 0; mid.textContent = t.center; countTo(mid); }
    } else if (mid.innerHTML !== t.center) { mid.innerHTML = t.center; mid.__shown = null; mid.__target = null; }
    el.querySelector('small').textContent = t.word;
  });
}

// The last 15 seconds, on a fixed time axis: points sit where they happened, newest at the right edge.
const SPAN = 15000;
function renderSpark(trail, now) {
  const W = 300, H = 38;
  const pts = (trail || []).filter((p) => p.t >= now - SPAN - 1500);
  const max = Math.max(25, ...pts.map((p) => p.v)) * 1.1;
  const X = (t) => Math.max(0, Math.min(W, ((t - (now - SPAN)) / SPAN) * W));
  const Y = (v) => H - (v / max) * (H - 3) - 1.5;
  let xy = pts.map((p) => [X(p.t), Y(p.v)]);
  if (!xy.length) xy = [[0, Y(0)], [W, Y(0)]];
  if (xy.length === 1) xy.unshift([Math.max(0, xy[0][0] - 1), xy[0][1]]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  $('sparkLine').setAttribute('d', line);
  $('sparkArea').setAttribute('d', `${line} L${xy[xy.length - 1][0].toFixed(1)} ${H} L${xy[0][0].toFixed(1)} ${H} Z`);
  const [lx, ly] = xy[xy.length - 1];
  $('sparkNow').setAttribute('cx', lx); $('sparkNow').setAttribute('cy', ly);
  $('graphSpan').textContent = 'last 15 seconds';
}

// ---------- the overall answer ----------
function renderHealth() {
  const h = snap?.health;
  if (!h) return;
  const el = $('health');
  el.className = `health ${h.level}`;
  $('hScore').textContent = h.score;
  if ($('hLabel').textContent !== h.label) $('hLabel').textContent = h.label;
  el.title = `Need debugging? ${h.answer}${h.reasons.length ? `\n• ${h.reasons.join('\n• ')}` : ''}`;
  el.setAttribute('aria-label', `Health ${h.score} out of 100: ${h.label}. ${h.answer}`);
}
$('health').addEventListener('click', () => { if (view !== 'mac' || picking) { view = 'mac'; picking = false; showAll = false; resetBoxes(); render(); } });

function actHTML(act, sid, k) {
  const id = `${sid}|${k}`;
  return `<button class="${act.calm ? 'alt' : 'go'}${running.has(id) ? ' busy' : ''}" data-act="${esc(id)}">${esc(act.label)}</button>`;
}
let current = []; // suggestions on screen, so a click finds its act
function renderFixes(list) {
  current = list;
  const box = $('fixes');
  const shown = list.filter((f) => !dismissed.has(f.id));
  // Forget a dismissed fix once its problem is gone, so it can come back if the problem does.
  for (const id of [...dismissed]) if (!list.some((f) => f.id === id)) dismissed.delete(id);
  $('fixBox').hidden = !shown.length;
  const sig = shown.map((f) => `${f.id}:${f.acts.map((a) => a.label).join()}`).join('|');
  if (box.dataset.sig === sig) {
    // Same fixes: only their words change (a live percentage, say). Update them where they are.
    for (const f of shown) {
      const card = box.querySelector(`.fix[data-id="${CSS.escape(f.id)}"]`);
      if (!card) continue;
      const b = card.querySelector('b'), p = card.querySelector('p');
      if (b.textContent !== f.title) b.textContent = f.title;
      if (p.textContent !== f.why) p.textContent = f.why;
    }
    return;
  }
  const pending = box.querySelector('.sure');
  if (pending) return; // don't redraw under a "Sure?" the person is about to click
  const known = new Set((box.dataset.ids || '').split(','));
  box.dataset.sig = sig;
  box.dataset.ids = shown.map((f) => f.id).join(',');
  box.innerHTML = shown.map((f, i) => `
    <div class="fix ${f.level === 'tip' ? 'tip' : f.level}" data-id="${esc(f.id)}" style="--d:${known.has(f.id) ? 0 : i * 50}ms;${known.has(f.id) ? 'animation:none' : ''}">
      <span class="ic">${ICON[f.level]}</span>
      <div><b>${esc(f.title)}</b><p>${esc(f.why)}</p>${f.acts.length ? `<div class="acts">${f.acts.map((a, k) => actHTML(a, f.id, k)).join('')}</div>` : ''}</div>
    </div>`).join('');
}

function verdictFor(list, a) {
  const bad = list.find((f) => f.level === 'bad'), warn = list.find((f) => f.level === 'warn');
  const top = bad || warn;
  if (top) return { level: bad ? 'bad' : 'warn', title: top.title, sub: bad ? 'Here’s what to do about it.' : 'Worth a look, below.' };
  if (a && !a.system) return { level: 'good', title: `${short(a.name)} is running fine`, sub: recent(a.history) < 2 ? 'It’s resting right now.' : 'Nothing here is slowing your Mac down.' };
  if (a?.system) return { level: 'good', title: 'macOS is running fine', sub: 'The background stuff is behaving.' };
  return { level: 'good', title: 'Your Mac is running smoothly', sub: snap.battery && !snap.battery.plugged && snap.battery.remaining ? `About ${duration(snap.battery.remaining)} of battery left.` : 'Nothing’s slowing it down right now.' };
}
function renderVerdict(v) {
  const box = $('verdict');
  box.className = `verdict ${v.level}`;
  if ($('face').dataset.level !== v.level) { $('face').dataset.level = v.level; $('face').innerHTML = FACE[v.level]; }
  if ($('vTitle').textContent !== v.title) $('vTitle').textContent = v.title;
  if ($('vSub').textContent !== v.sub) $('vSub').textContent = v.sub;
}

function rowHTML(a, i, max) {
  const share = recent(a.history, 2);
  const lv = lvl(share, 15, 35);
  const width = Math.max(share > 0.3 ? 4 : 0, Math.min(100, (share / max) * 100));
  const sub = a.system ? 'Everything running in the background' : a.awake.length ? 'Keeping your Mac awake' : a.self ? 'That’s us' : `${a.procs} part${a.procs === 1 ? '' : 's'}`;
  return `<button class="rowb" data-key="${esc(a.key)}" data-rk="${esc(a.key)}" style="--d:${i * 30}ms">${appIcon(a)}<span class="nm">${esc(a.name)}<small>${esc(sub)}</small></span>
    <span class="meter ${lv}"><i style="width:${width}%"></i></span><span class="num"><b>${share < 1 && share > 0 ? '<1' : Math.round(share)}%</b> · ${bytes(a.mem)}</span></button>`;
}
function partHTML(p, i, max) {
  const lv = lvl(p.cpu, 15, 35);
  const width = Math.max(p.cpu > 0.3 ? 4 : 0, Math.min(100, (p.cpu / max) * 100));
  return `<div class="rowb static" data-rk="part:${esc(p.name)}" style="--d:${i * 30}ms"><svg class="macic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>
    <span class="nm">${esc(p.label || p.name)}<small>${esc(p.label ? p.name : p.count > 1 ? `${p.count} copies` : 'part of macOS')}</small></span>
    <span class="meter ${lv}"><i style="width:${width}%"></i></span><span class="num"><b>${p.cpu < 1 && p.cpu > 0 ? '<1' : Math.round(p.cpu)}%</b> · ${bytes(p.mem)}</span></div>`;
}
function renderList(a) {
  const box = $('rows');
  let html;
  if (!a) {
    const apps = snap.apps;
    const list = showAll ? apps : apps.slice(0, 5);
    const max = Math.max(10, ...list.map((x) => recent(x.history, 2)));
    $('listTitle').textContent = 'Busiest apps';
    $('listNote').textContent = `${snap.appCount} open`;
    html = list.map((x, i) => rowHTML(x, i, max)).join('') + (apps.length > 5 ? `<button class="more" id="moreBtn" data-rk="more">${showAll ? 'Show fewer' : `Show all ${apps.length}`}</button>` : '');
  } else if (a.system) {
    const parts = a.parts.slice(0, showAll ? 12 : 5);
    const max = Math.max(10, ...parts.map((p) => p.cpu));
    $('listTitle').textContent = 'Busiest parts of macOS';
    $('listNote').textContent = '';
    html = parts.map((p, i) => partHTML(p, i, max)).join('') + (a.parts.length > 5 ? `<button class="more" id="moreBtn" data-rk="more">${showAll ? 'Show fewer' : 'Show more'}</button>` : '');
  }
  $('listBox').hidden = !html;
  if (!html) return;
  syncRows(box, html);
}

// Keep each row (by its key) and update it where it stands: bars and numbers glide to their new values,
// a row that changes places slides there, only a new row pops in, and one that's gone just leaves.
// Redrawing the list every look made every row flash.
function syncRows(box, html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const fresh = [...tmp.children];
  const old = new Map([...box.querySelectorAll(':scope > [data-rk]')].map((el) => [el.dataset.rk, el]));
  const before = new Map([...old].map(([k, el]) => [k, el.getBoundingClientRect().top]));
  const first = !box.children.length;
  const out = fresh.map((el, i) => {
    const k = el.dataset.rk;
    const was = k && old.get(k);
    if (!was) {
      if (!first) el.style.setProperty('--d', `${i * 20}ms`);
      el.classList.add('enter');
      return el;
    }
    old.delete(k);
    const m = el.querySelector('.meter'), om = was.querySelector('.meter');
    if (m && om) {
      om.className = m.className;
      om.firstElementChild.style.width = m.firstElementChild.style.width;
    }
    for (const sel of ['.num', '.nm']) {
      const n = el.querySelector(sel), on = was.querySelector(sel);
      if (!n || !on || on.innerHTML === n.innerHTML) continue;
      // Keep where the percentage was showing, so it counts on from there (countTo, below).
      const ob = on.querySelector('b');
      const shown = ob ? ob.__shown ?? (Number.parseInt(ob.textContent.replace('<', ''), 10) || 0) : null;
      on.innerHTML = n.innerHTML;
      if (shown != null && on.querySelector('b')) on.querySelector('b').__shown = shown;
    }
    const ic = el.querySelector('img'), oic = was.querySelector('img, .avatar');
    if (ic && oic && oic.tagName !== 'IMG') oic.replaceWith(ic); // its icon arrived
    return was;
  });
  for (const el of old.values()) el.remove();
  // Put them in order, moving only what's out of place (a move would otherwise restart nothing, but
  // keeping the rest still keeps the page calm), then slide moved rows from where they were.
  out.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
  while (box.children.length > out.length) box.lastElementChild.remove();
  for (const el of out) {
    const top = before.get(el.dataset.rk);
    if (top == null) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 700, easing: GLIDE });
  }
  box.querySelectorAll('.num b').forEach(countTo);
}
const GLIDE = 'cubic-bezier(0.22, 1, 0.36, 1)';

// A number like "37%" counts to its new value instead of jumping. `el` holds the target text; the
// count runs on the element's first text, so the next update can start from wherever it got to.
function countTo(el) {
  const target = el.textContent;
  const m = /^(<?)(\d+)%$/.exec(target);
  const from = el.__shown;
  el.__shown = m ? Number(m[2]) : null;
  if (!m || m[1] || from == null || from === el.__shown || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = el.__shown, t0 = performance.now();
  cancelAnimationFrame(el.__raf);
  el.textContent = `${from}%`;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 900), e = 1 - (1 - k) ** 3;
    el.textContent = `${Math.round(from + (to - from) * e)}%`;
    if (k < 1) el.__raf = requestAnimationFrame(step);
  };
  el.__raf = requestAnimationFrame(step);
}

function renderFacts(a) {
  const s = snap;
  let rows = [];
  if (!a) {
    const b = s.battery;
    rows = [
      ['Running for', days(s.uptime)],
      ['Memory used', `${bytes(s.mem.used)} of ${bytes(s.mem.total)}`],
      ['Spilled to storage', s.mem.swapUsed ? bytes(s.mem.swapUsed) : 'None'],
      ['Processor cores', `${s.cores}`],
    ];
    if (b) rows.push(['Battery health', b.health != null ? `${b.health}%` : '–'], ['Charge cycles', b.cycles != null ? `${b.cycles}` : '–']);
    if (b?.temp) rows.push(['Battery temp', `${Math.round(b.temp)}°C`]);
    rows.push(['Heat', s.heat?.throttled ? 'Slowing down to cool' : 'Normal']);
  } else if (!a.system) {
    rows = [
      ['Uses now', `${Math.round(recent(a.history, 2))}% of your Mac`],
      ['Memory', bytes(a.mem)],
      ['Parts running', `${a.procs}`],
      ['Keeps Mac awake', a.awake.length ? 'Yes' : 'No'],
    ];
  }
  $('factBox').hidden = !rows.length;
  $('facts').innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('');
}

const CHIP_ICON = {
  quit: '<path d="M12 3v8"/><path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0"/>',
  reopen: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  force: '<path d="M13 3 6 13h5l-1 8 7-10h-5z"/>',
  finder: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16M8 9v1M16 9v1M8 15c2.5 1.5 5.5 1.5 8 0"/>',
  dock: '<rect x="3" y="15" width="18" height="5" rx="2"/><path d="M7 11h2M11 11h2M15 11h2"/>',
  menubar: '<rect x="3" y="4" width="18" height="4" rx="1.5"/><path d="M5 12h14M5 16h9"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
};
const chip = (act, id) => `<button class="chip${running.has(id) ? ' busy' : ''}" data-act="${esc(id)}"><svg viewBox="0 0 24 24">${CHIP_ICON[act.kind] || ''}</svg>${esc(act.label)}</button>`;
let chipActs = {};
function renderChips(a) {
  const quick = [
    { label: 'Restart Finder', kind: 'finder' },
    { label: 'Restart Dock', kind: 'dock' },
    { label: 'Fix menu bar', kind: 'menubar' },
    { label: 'Empty Trash', kind: 'trash', confirm: 'Deleted for good.' },
    { label: 'Activity Monitor', kind: 'activity' },
    { label: 'Restart Mac…', kind: 'restart' },
  ];
  const appActs = a && !a.system && !a.self ? [
    { label: 'Quit', kind: 'quit', app: a, confirm: cfg?.confirm ? 'It may ask to save.' : null },
    { label: 'Reopen', kind: 'reopen', app: a, confirm: cfg?.confirm ? 'Quits, then opens again.' : null },
    { label: 'Force quit', kind: 'force', app: a, confirm: 'Unsaved work is lost.' },
  ] : [];
  chipActs = {};
  quick.forEach((q, i) => { chipActs[`quick|${i}`] = q; });
  appActs.forEach((q, i) => { chipActs[`app|${i}`] = q; });
  $('appActBox').hidden = !appActs.length;
  $('quickBox').hidden = !!(a && !a.system);
  if ($('appActs').querySelector('.sure') || $('quick').querySelector('.sure')) return;
  const qa = appActs.map((q, i) => chip(q, `app|${i}`)).join('');
  const qq = quick.map((q, i) => chip(q, `quick|${i}`)).join('');
  if ($('appActs').innerHTML !== qa) $('appActs').innerHTML = qa;
  if ($('quick').innerHTML !== qq) $('quick').innerHTML = qq;
}

function renderTabs() {
  const a = appByKey(appKey);
  $('seg').dataset.view = view;
  $('appTab').setAttribute('aria-checked', view === 'app');
  $('macTab').setAttribute('aria-checked', view === 'mac');
  const name = a ? short(a.name) : 'This app';
  if ($('appTabName').textContent !== name) $('appTabName').textContent = name;
  const ic = a ? appIcon(a) : '';
  if ($('appTabIc').dataset.k !== `${a?.key}:${!!a?.icon}`) { $('appTabIc').dataset.k = `${a?.key}:${!!a?.icon}`; $('appTabIc').innerHTML = ic; }
  $('chev').classList.toggle('up', picking);
}

function render() {
  if (!snap || !cfg) return;
  // The app you were looking at quit: back to the whole Mac.
  if (view === 'app' && !appByKey(appKey)) { if (appKey) view = 'mac'; appKey = appKey || 'macos'; }
  const a = view === 'app' ? appByKey(appKey) : null;
  renderTabs();
  renderHealth();
  $('main').hidden = picking;
  $('picker').hidden = !picking;
  if (picking) { renderPicker(); renderPill(); moreBelow(); return; }
  const list = a ? appSuggestions(snap, a) : macSuggestions(snap);
  // In an app's view, the whole Mac's red flags still show (a full disk matters wherever you are).
  if (a) for (const f of macSuggestions(snap)) if (f.level === 'bad' && !list.some((x) => x.id === f.id) && !f.id.startsWith('hot:')) list.push(f);
  renderVerdict(verdictFor(list, a));
  renderTiles(tilesFor(snap, a));
  $('graphLabel').textContent = a ? `${short(a.name)}’s processor use` : 'Processor use';
  renderSpark(a ? a.trail : snap.cpu.trail, snap.at);
  renderFixes(list.sort((x, y) => ({ bad: 0, warn: 1, tip: 2 }[x.level] - { bad: 0, warn: 1, tip: 2 }[y.level])));
  renderList(a);
  renderFacts(a);
  renderChips(a);
  renderPill();
  moreBelow();
}

function renderPicker() {
  const apps = [...snap.apps];
  const max = Math.max(10, ...apps.map((x) => recent(x.history, 2)));
  syncRows($('pickRows'), apps.map((x, i) => rowHTML(x, i, max)).join(''));
}

function renderPill() {
  if (!snap) return;
  const h = snap.health;
  $('pillDot').className = `dot ${h?.level || 'good'}`;
  $('pillScore').textContent = h ? `${h.score}` : '';
  $('pillCpu').textContent = `${snap.cpu.total}%`;
  $('pillMem').textContent = `${Math.round((snap.mem.used / snap.mem.total) * 100)}%`;
  $('pillOpen').title = h ? `${h.label}: ${h.answer}` : '';
}

// ---------- running a fix ----------
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}
function findAct(id) {
  if (chipActs[id]) return chipActs[id];
  const [sid, k] = id.split('|');
  return current.find((f) => f.id === sid)?.acts[Number(k)];
}
async function runAct(btn, id, act) {
  if (act.kind === 'view') { choose(act.app.key); return; }
  // Ask first, right on the button: it turns dark and says what will happen.
  if (act.confirm && !btn.classList.contains('sure')) {
    document.querySelectorAll('.sure').forEach(unsure);
    btn.classList.add('sure');
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = `${btn.querySelector('svg')?.outerHTML || ''}Sure? ${esc(act.label)}`;
    const note = document.createElement('span');
    note.className = 'sure-note';
    note.textContent = act.confirm;
    (btn.closest('.acts') || btn.parentElement).append(note);
    btn.sureTimer = setTimeout(() => unsure(btn), 5000);
    fit();
    return;
  }
  unsure(btn);
  running.add(id);
  btn.classList.add('busy');
  const r = await scrawl.invoke('debug:fix', act.kind, act.app ? { pid: act.app.pid } : null);
  running.delete(id);
  btn.classList.remove('busy');
  toast(r?.message || (r?.ok ? 'Done.' : 'That didn’t work.'), !r?.ok);
  const card = btn.closest('.fix');
  if (r?.ok && card && !act.kind.startsWith('open:')) {
    dismissed.add(card.dataset.id);
    card.classList.add('done');
    setTimeout(() => { $('fixes').dataset.sig = ''; render(); }, 420);
  }
}
function unsure(btn) {
  if (!btn.classList.contains('sure')) return;
  clearTimeout(btn.sureTimer);
  btn.classList.remove('sure');
  btn.innerHTML = btn.dataset.label;
  (btn.closest('.acts') || btn.parentElement).querySelector('.sure-note')?.remove();
  fit();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) { const act = findAct(b.dataset.act); if (act) runAct(b, b.dataset.act, act); return; }
  if (!e.target.closest('.sure')) document.querySelectorAll('.sure').forEach(unsure);
  const row = e.target.closest('.rowb[data-key]');
  if (row) { choose(row.dataset.key); return; }
  if (e.target.closest('#moreBtn')) { showAll = !showAll; $('rows').dataset.keys = ''; render(); }
});

// ---------- switching views ----------
function choose(key) {
  appKey = key;
  view = 'app';
  picking = false;
  showAll = false;
  resetBoxes();
  render();
  $('body').scrollTo({ top: 0, behavior: 'smooth' });
}
function resetBoxes() { for (const id of ['rows', 'fixes', 'tiles']) { $(id).dataset.keys = ''; $(id).dataset.sig = ''; $(id).dataset.view = ''; } }
$('appTab').addEventListener('click', (e) => {
  if (e.target.closest('#chev') || view === 'app') { picking = !picking; $('pickRows').dataset.keys = ''; render(); return; }
  view = 'app'; picking = false; showAll = false; resetBoxes(); render();
});
$('macTab').addEventListener('click', () => { if (view === 'mac' && !picking) return; view = 'mac'; picking = false; showAll = false; resetBoxes(); render(); });
$('pickBack').addEventListener('click', () => { picking = false; render(); });

// ---------- folding up, closing ----------
function setMini(on) {
  mini = on;
  $('card').hidden = on;
  $('pill').hidden = !on;
  scrawl.send('debug:mini', on);
  fit();
}
$('mini').addEventListener('click', () => setMini(true));
$('pillOpen').addEventListener('click', () => setMini(false));
$('close').addEventListener('click', () => scrawl.send('debug:close'));
$('pillClose').addEventListener('click', () => scrawl.send('debug:close'));
$('gear').addEventListener('click', () => scrawl.send('debug:openSettings'));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (picking) { picking = false; render(); } else scrawl.send('debug:close'); }
});

// The window takes the size of what's showing.
let fitFrame = 0;
function fit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    const w = $('wrap');
    scrawl.send('debug:fit', { w: w.offsetWidth, h: w.offsetHeight, ready: !!snap });
  });
}
new ResizeObserver(fit).observe($('wrap'));
// Fade the bottom edge while there's more to scroll to.
function moreBelow() {
  const b = $('body');
  b.classList.toggle('more-below', b.scrollHeight - b.scrollTop - b.clientHeight > 8);
}
$('body').addEventListener('scroll', moreBelow, { passive: true });

// ---------- go ----------
$('mark').innerHTML = Tools.glyph('debug', 19);
$('pillGrab').innerHTML = Tools.glyph('debug', 17);
scrawl.invoke('debug:init').then(({ settings, front, self }) => {
  cfg = settings;
  selfPid = self;
  frontKey = front ? front.bundle || front.name : null;
  appKey = frontKey || 'macos';
  view = settings.start === 'mac' || !frontKey ? 'mac' : 'app';
  render();
  fit();
  scrawl.send('debug:refresh'); // the first look may have gone out before this page was listening
});
scrawl.on('debug:data', (s) => {
  const first = !snap;
  snap = s;
  // The app you were in isn't in the list (it was Pane itself, say): start on the whole Mac.
  if (first && view === 'app' && !appByKey(appKey)) { view = 'mac'; appKey = 'macos'; }
  render();
  if (first) fit(); // tells the main process its first look is drawn, so the window can appear
});
// The window is on screen now: play the opening (held until then, so it isn't over before you see it).
scrawl.on('debug:shown', () => document.body.classList.add('shown'));
scrawl.on('debug:settings', (s) => { cfg = s; resetBoxes(); render(); fit(); });
