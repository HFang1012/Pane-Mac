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
// The plugin on an app, if it has one (Plugin, the tool: see plugin-engine.js).
const plugFor = (a) => (a && !a.system ? (snap?.plugins || []).find((p) => (a.bundle ? p.bundle === a.bundle : p.name === a.name)) : null);
const plugAct = (a) => (!snap?.pluginOn || a.self ? null : plugFor(a) ? { label: 'Open its plugin', kind: 'plugin', app: a, calm: true } : { label: 'Hold it to a share', kind: 'plug', app: a, calm: true });
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

// ---------- single processes burning the processor ----------
// The panel's per-app numbers add up every part of an app, so this looks one level down: the single
// process doing the work (see topProcesses in debug-stats.js), what it is, and the fix that fits it.
const mins = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} hr${sec >= 7200 ? 's' : ''}${Math.round((sec % 3600) / 60) ? ` ${Math.round((sec % 3600) / 60)} min` : ''}` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`);
// "Extreme": most of a core for 10 seconds or more, or pinned at one core like it's stuck.
const extreme = (p) => !p.self && (p.steady || (p.avg >= 80 && p.busyFor >= 8) || p.avg >= 150);
const RENDERER = /Helper \([^)]*Renderer\)|com\.apple\.WebKit\.WebContent/;
const GPUPROC = /Helper \(GPU\)|com\.apple\.WebKit\.GPU/;
function procSuggestion(p, s) {
  const app = p.ownerKey ? appByKey(p.ownerKey) : null;
  const owner = p.ownerName ? short(p.ownerName) : null;
  const pctTxt = `${p.avg}% of one core`;
  const forTxt = p.busyFor >= 30 ? ` for ${mins(p.busyFor)}` : '';
  const onBattery = s.battery && !s.battery.plugged;
  const endable = p.mine && !p.protected && !p.self;
  const end = (label = 'End it', confirm = 'Anything it hasn’t saved is lost.') => ({ label, kind: 'endproc', proc: p, confirm });
  const force = { label: 'Force end', kind: 'killproc', proc: p, confirm: 'It stops at once. Unsaved work is lost.', calm: true };
  const level = (p.avg >= 90 && (p.busyFor >= 60 || p.steady)) || p.avg >= 200 ? 'bad' : 'warn';
  const base = { id: `proc:${p.pid}:${p.name}`, level, proc: p };
  const idleNote = p.idle ? ` while you’re not even using ${owner}` : '';
  const chronicNote = p.chronic ? ` It’s used ${mins(p.cpuTime)} of processor time since your Mac started.` : '';
  // A browser tab (or extension): ending its process just crashes that one tab.
  if (RENDERER.test(p.name) && owner) {
    const chromium = CHROMIUM.includes(app?.bundle);
    return { ...base, title: `A tab in ${owner} is burning the processor`,
      why: `One tab or extension is using ${pctTxt}${forTxt}${idleNote}.${chromium ? ` Window › Task Manager in ${owner} shows which one.` : ''} Ending it only stops that tab; reload it to get it back.${chronicNote}`,
      acts: endable ? [end('End that tab', 'That tab shows a crash page until you reload it.'), ...(app ? [lookAct(app)] : [])] : [] };
  }
  if (GPUPROC.test(p.name) && owner) {
    return { ...base, title: `${owner}’s graphics part is working hard`,
      why: `It’s using ${pctTxt}${forTxt}. A video, a game or an animated page usually does it. Ending it makes ${owner} redraw for a second, then it settles.`,
      acts: endable ? [end('Reset its graphics', `${owner} flickers for a moment.`)] : [] };
  }
  switch (p.cat) {
    case 'kernel':
      return { ...base, level: 'warn', title: 'Your Mac is holding itself back to cool off',
        why: `kernel_task is at ${pctTxt}. That isn’t a bug: macOS takes processor time away from apps when the Mac is hot, or charging hard. Quit busy apps, unplug extra displays and give it air.`,
        acts: [{ label: 'Activity Monitor', kind: 'activity', calm: true }] };
    case 'screen':
      return { ...base, level: 'warn', title: `${p.name} is working hard drawing the screen`,
        why: `It’s at ${pctTxt}${forTxt}. Lots of open windows, a big or high-refresh external display, and see-through effects all add up.${p.name === 'WindowServer' ? '' : ` Restarting ${p.name} is safe; macOS opens it again.`}`,
        acts: [{ label: 'Reduce motion & transparency', kind: 'open:display', calm: true }, ...(p.name === 'Dock' ? [{ label: 'Restart Dock', kind: 'dock' }] : /^(ControlCenter|SystemUIServer)$/.test(p.name) ? [{ label: 'Fix menu bar', kind: 'menubar' }] : [])] };
    case 'search': {
      const long = p.busyFor >= 20 * 60 || p.chronic;
      return { ...base, level: long ? 'warn' : 'tip', title: long ? `Spotlight has been indexing for ${mins(Math.max(p.busyFor, p.cpuTime))}` : 'Spotlight is indexing your files',
        why: long ? `${p.name} is at ${pctTxt}. Indexing that never ends is usually stuck: a restart unsticks it. Keeping huge folders (code projects, virtual machines, downloads) out of Spotlight stops it from coming back.`
          : `${p.name} is at ${pctTxt}. It catches up after big changes and finishes on its own, so it’s fine to wait.`,
        acts: long ? [{ label: 'Spotlight settings', kind: 'open:spotlight', calm: true }, { label: 'Restart…', kind: 'restart' }] : [{ label: 'Spotlight settings', kind: 'open:spotlight', calm: true }] };
    }
    case 'dev':
      return { ...base, title: p.steady ? `${p.name} looks stuck` : `${p.name} is burning the processor`,
        why: `Something started from a terminal or code editor is at ${pctTxt}${forTxt}${p.steady ? ', pinned at one core, which usually means a loop that won’t end' : ''}. If you didn’t mean for it to still be running, end it.${chronicNote}`,
        acts: endable ? [end(), ...(p.steady ? [force] : [])] : [] };
    case 'helpers':
      if (!owner) {
        return { ...base, title: `${p.helperOf || p.name} is busy in the background`,
          why: `${p.name}, a background part of ${p.helperOf || 'an app you installed'}, is at ${pctTxt}${forTxt}, with the app itself closed.${chronicNote} Ending it is safe; turning it off in Login Items keeps it from starting again.`,
          acts: [...(endable ? [end()] : []), { label: 'Login Items', kind: 'open:login', calm: true }] };
      }
      break;
    case 'sound':
      return { ...base, level: 'tip', title: 'Sound or video is taking real work',
        why: `${p.name} is at ${pctTxt}. It plays sound and decodes video for every app, so quitting apps you aren’t watching or listening to calms it.`, acts: [] };
    default:
      if (p.passes) {
        return { ...base, level: p.busyFor >= 3600 ? 'warn' : 'tip', title: `${p.catLabel}: ${p.name} is busy`,
          why: `It’s at ${pctTxt}${forTxt}. This finishes on its own, faster if your Mac stays plugged in and awake.${p.busyFor >= 3600 ? ' After an hour or more it may be stuck; a restart settles it.' : ''}`,
          acts: p.busyFor >= 3600 ? [{ label: 'Restart…', kind: 'restart', calm: true }] : [] };
      }
  }
  // A part of an open app, or the app itself.
  if (owner && app) {
    const what = p.main ? owner : `${p.name}, part of ${owner},`;
    return { ...base, title: p.steady ? `${owner} looks stuck` : p.idle ? `${owner} is wasting power in the background` : `${owner} is burning the processor`,
      why: `${what} is using ${pctTxt}${forTxt}${idleNote}${p.steady ? ', pinned at one core like it’s stuck in a loop' : ''}${onBattery ? ', draining your battery' : ''}.${chronicNote} ${p.steady ? 'If it isn’t responding, force it to quit.' : 'Quitting it frees that up.'}`,
      acts: app.self ? [] : [quitAct(app), ...(p.main ? (p.steady ? [{ label: 'Force quit', kind: 'force', app, confirm: 'Anything you haven’t saved is lost.', calm: true }] : []) : endable ? [end(`End just ${p.name.length > 22 ? 'that part' : p.name}`)] : [])] };
  }
  if (endable) {
    return { ...base, title: p.steady ? `${p.name} looks stuck` : `${p.name} is burning the processor`,
      why: `It’s at ${pctTxt}${forTxt}${p.steady ? ', pinned at one core like it’s stuck in a loop' : ''}.${chronicNote} It isn’t part of an open app, so ending it is usually safe.`,
      acts: [end(), ...(p.steady ? [force] : [])] };
  }
  return { ...base, level: p.busyFor >= 600 ? 'warn' : 'tip', title: `${p.name} (part of macOS) is busy`,
    why: `It’s at ${pctTxt}${forTxt}. It belongs to macOS, so Pane can’t end it. If it stays this busy for a long time, a restart settles it.${chronicNote}`,
    acts: [{ label: 'Restart…', kind: 'restart', calm: true }] };
}
// Process fixes for the worst offenders, and which apps and background groups they already explain
// (so "Chrome is working hard" doesn't show next to "A tab in Chrome is burning the processor").
function procFixes(s, filter = () => true, max = 2) {
  const hogs = (s.procs || []).filter((p) => extreme(p) && filter(p)).slice(0, max);
  const fixes = hogs.map((p) => procSuggestion(p, s));
  return { fixes, apps: new Set(hogs.map((p) => p.ownerKey).filter(Boolean)), cats: new Set(hogs.filter((p) => !p.ownerKey).map((p) => p.cat)) };
}

function macSuggestions(s) {
  const out = [];
  const apps = s.apps.filter((a) => !a.self && !a.system);
  const onBattery = s.battery && !s.battery.plugged;
  const pf = procFixes(s);
  out.push(...pf.fixes);
  // Apps working hard: the biggest drain on speed and battery.
  for (const a of apps.filter(hot).filter((a) => !pf.apps.has(a.key)).slice(0, 2)) {
    const share = Math.round(recent(a.history));
    const stuck = share < 20; // one core flat out: often an app stuck in a loop
    out.push({
      id: `hot:${a.key}`, level: share >= 40 ? 'bad' : 'warn',
      title: stuck ? `${short(a.name)} is keeping a core busy` : `${short(a.name)} is working hard`,
      why: stuck ? `It’s using ${Math.round(recent(a.history) * s.cores)}% of one core${stuckLike(a, s) ? ', steadily, which can mean it’s stuck. Quitting it helps' : onBattery ? ', which drains your battery' : ''}.`
        : `It’s using ${share}% of your Mac’s power${onBattery ? ', which drains your battery fast' : ', which can slow everything else down'}.`,
      acts: [quitAct(a), lookAct(a)],
    });
  }
  // Something in the background busy: often it finishes on its own.
  const sys = s.apps.find((a) => a.system);
  for (const p of (sys?.parts || []).filter((p) => p.id !== 'other' && p.core >= 60 && !pf.cats.has(p.id)).slice(0, 1)) out.push(catSuggestion(p, sys));
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

// A background category that's busy (see CATEGORIES in debug-stats.js), named by what's doing the work.
const PLURAL = new Set(['helpers', 'dev', 'other']);
function catSuggestion(p, sys) {
  const screen = p.id === 'screen';
  const who = p.top?.[0]?.name;
  const one = Math.round(p.core);
  if (screen) {
    return {
      id: 'sys:screen', level: 'tip', title: 'Drawing the screen is taking a lot of work',
      why: `It’s using ${one}% of one core. Lots of open windows, a big external display or see-through effects all add up. Closing windows you don’t need helps.`,
      acts: [{ label: 'Reduce motion & transparency', kind: 'open:display', calm: true }],
    };
  }
  const next = p.passes ? 'It finishes on its own, so it’s fine to wait.'
    : p.id === 'helpers' ? `Quitting ${who || 'the app it belongs to'} from its menu bar icon, or turning it off in Login Items, stops it.`
      : p.id === 'dev' ? 'Stop it in the terminal or editor that started it.'
        : 'If it stays busy for a long time, a restart usually settles it.';
  return {
    id: `sys:${p.id}`, level: 'tip',
    title: `${p.label} ${PLURAL.has(p.id) ? 'are' : 'is'} busy`,
    why: `${p.label} ${p.about}${who ? `. Mostly ${who}` : ''}, at ${one}% of one core. ${next}`,
    acts: p.id === 'helpers' ? [{ label: 'Login Items', kind: 'open:login', calm: true }]
      : !p.passes && p.id !== 'dev' && sys && view !== 'app' ? [{ label: 'Look closer', kind: 'view', app: sys, calm: true }] : [],
  };
}

// Stuck in a loop: one core flat out (90–110%), barely moving, for the last several looks.
function stuckLike(a, s) {
  const last = (a.history || []).slice(-5).map((v) => v * s.cores);
  return last.length >= 5 && last.every((v) => v >= 90 && v <= 110) && Math.max(...last) - Math.min(...last) < 12;
}

// How much memory is fine for an app. `normal`: nothing to say below it. `heavy`: too much.
// Browsers: up to a quarter of the Mac's memory (at least 4 GB) is normal, past 35% (at least 6 GB) too much.
// Other apps: past 15% (at least 2 GB) is a lot, past a quarter too much. Graphics: up to 6% (at least 1.5 GB).
const GB = 1073741824;
function memLimits(a, s) {
  const t = s.mem.total;
  return BROWSERS.includes(a.bundle)
    ? { normal: Math.max(4 * GB, t * 0.25), heavy: Math.max(6 * GB, t * 0.35), gpu: Math.max(1.5 * GB, t * 0.06) }
    : { normal: Math.max(2 * GB, t * 0.15), heavy: Math.max(3 * GB, t * 0.25), gpu: Math.max(1.5 * GB, t * 0.06) };
}
function appSuggestions(s, a) {
  const out = [];
  const pf = procFixes(s, (p) => (a.system ? !p.ownerKey : p.ownerKey === a.key), 3);
  out.push(...pf.fixes);
  if (a.system) {
    for (const p of (a.parts || []).filter((p) => p.core >= 50 && !pf.cats.has(p.id)).slice(0, 2)) out.push(catSuggestion(p, a));
    if (!out.length && recent(a.history) >= 25) out.push({ id: 'sys-busy', level: 'tip', title: 'Your Mac is busy in the background', why: 'Updates, backups and indexing run when they can. A restart helps if it never calms down.', acts: [{ label: 'Restart…', kind: 'restart', calm: true }] });
    return out;
  }
  const share = Math.round(recent(a.history));
  const onBattery = s.battery && !s.battery.plugged;
  if (hot(a) && !pf.apps.has(a.key)) {
    out.push({
      id: `hot:${a.key}`, level: share >= 40 ? 'bad' : 'warn',
      // A stuck app pins exactly one core, on and on. Anything spread over more is just real work.
      title: share >= 20 ? `${short(a.name)} is working hard` : stuckLike(a, s) ? `${short(a.name)} may be stuck` : `${short(a.name)} is keeping a core busy`,
      why: share >= 20 ? `It’s using ${share}% of your Mac’s power (${Math.round(recent(a.history) * s.cores)}% of one core)${onBattery ? ' and draining your battery' : ''}. Quitting it frees that up.`
        : stuckLike(a, s) ? 'It’s been running one core flat out, steadily. If it isn’t responding, force it to quit.'
          : `It’s using ${Math.round(recent(a.history) * s.cores)}% of one core${onBattery ? ', which drains your battery' : ''}. Fine for a video or an export; if it isn’t doing anything, quit it.`,
      acts: [quitAct(a), ...(share < 20 && stuckLike(a, s) ? [{ label: 'Force quit', kind: 'force', app: a, confirm: 'Anything you haven’t saved is lost.' }] : []), ...(plugAct(a) ? [plugAct(a)] : [])],
    });
  }
  // Memory. Browsers get a higher bar: every tab is its own little app, so lots of memory is normal for
  // them. And an app's graphics (GPU) part is judged on its own. Each is only flagged once it's too much.
  const lim = memLimits(a, s);
  const browser = BROWSERS.includes(a.bundle);
  const tabsAct = { label: 'Close duplicate tabs', kind: 'tabs', app: a, confirm: 'Tabs showing a page that’s already open in another tab will close.' };
  const reopenAct = { label: `Reopen ${short(a.name)}`, kind: 'reopen', app: a, confirm: cfg?.confirm ? 'It quits, then opens again.' : null };
  const tight = s.mem.pressure !== 'normal';
  if (a.mem > lim.heavy) {
    out.push({
      id: `mem:${a.key}`, level: 'warn',
      title: `${short(a.name)} is using too much memory`,
      why: `About ${bytes(a.mem)}, more than ${browser ? 'even a busy browser needs' : 'it should'}. ${browser ? 'Closing tabs you’re done with, or reopening it, frees it up.' : 'Apps build up memory over time. Reopening it starts it fresh.'}`,
      acts: browser ? [tabsAct, reopenAct] : [reopenAct],
    });
  } else if (a.mem > lim.normal) {
    out.push({
      id: `mem:${a.key}`, level: tight ? 'warn' : 'tip',
      title: `${short(a.name)} is using a lot of memory`,
      why: browser
        ? `About ${bytes(a.mem)}. Every tab uses memory, even ones you can’t see. ${CHROMIUM.includes(a.bundle) ? `To find the heaviest, open Window › Task Manager in ${short(a.name)}.` : 'Closing ones you’re done with helps.'}`
        : `About ${bytes(a.mem)}. Apps build up memory over time. Reopening it starts it fresh.`,
      acts: browser ? [tabsAct] : [reopenAct],
    });
  } else if (browser && a.mem > 1073741824) {
    out.push({
      id: `memok:${a.key}`, level: 'ok',
      title: 'Normal for a browser',
      why: `${bytes(a.mem)} sounds like a lot, but every tab is its own little app, so browsers always use plenty. ${a.mem > lim.normal * 0.85 ? 'It’s getting close to too much, though: closing a few tabs keeps it there.' : `It’s fine up to about ${bytes(lim.normal)}.`}`,
      acts: [],
    });
  }
  // Graphics memory: some is normal for anything that draws on screen.
  if (a.gpu > lim.gpu) {
    out.push({
      id: `gpu:${a.key}`, level: a.gpu > lim.gpu * 2 || tight ? 'warn' : 'tip',
      title: 'Its graphics memory is high',
      why: `${short(a.name)}’s graphics (GPU) part holds ${bytes(a.gpu)}. Some is normal, this much isn’t. ${browser ? 'A video or game in a tab can do it; closing that tab or reopening the browser clears it.' : 'Reopening it clears it.'}`,
      acts: [reopenAct],
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
    // In "one core" terms too, like Activity Monitor's % CPU: on a 12-core Mac one core flat out is only 8%
    // of the whole, but it's still an app working hard (and what drains a battery).
    const core = share * s.cores, core3 = recent(a.history) * s.cores;
    const energy = core3 >= 150 || recent(a.history) >= 25 ? 'High' : core3 >= 30 ? 'Medium' : 'Low';
    const word = share >= 35 || core >= 150 ? 'Working hard' : share >= 10 || core >= 40 ? 'Busy' : 'Calm';
    return [
      ring(share, 'Processor', word, word === 'Working hard' ? 'bad' : word === 'Busy' ? 'warn' : 'good', pct(share)), // a full ring is the whole Mac
      ring(memPct, 'Memory', bytes(a.mem), a.mem > memLimits(a, s).heavy ? 'bad' : a.mem > memLimits(a, s).normal ? 'warn' : 'good', pct(memPct)), // a full ring is all of its memory
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

// ---------- live: frames, graphics, network, disk ----------
// FPS is measured right here: this panel asks for a frame on every screen refresh and counts how many it
// gets. Its window is drawn by macOS like any other, so when the Mac can't keep up, it drops frames too.
// A dropped frame is a gap of about two frames or more. The usual gap is read from what's actually
// arriving (a 120 Hz screen can still hand out 60), so a steady lower rate isn't counted as dropping.
const fps = { t0: 0, last: 0, frames: 0, gaps: [], value: null, dropped: 0, frameMs: null };
function frame(now) {
  if (fps.last) fps.gaps.push(now - fps.last);
  fps.last = now;
  fps.frames++;
  if (!fps.t0) fps.t0 = now;
  const span = now - fps.t0;
  if (span >= 1000) {
    const sorted = [...fps.gaps].sort((x, y) => x - y);
    const usual = sorted[Math.floor(sorted.length / 2)] || 16.7;
    fps.value = Math.round(((fps.frames - 1) * 1000) / span) || 0;
    fps.dropped = fps.gaps.reduce((n, g) => n + (g > usual * 1.7 ? Math.round(g / usual) - 1 : 0), 0);
    fps.frameMs = usual;
    fps.t0 = now; fps.frames = 1; fps.gaps = [];
    renderLive();
    renderPill();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function fpsLevel() {
  if (fps.value == null) return 'good';
  const total = fps.value + fps.dropped;
  const dropPct = total ? (fps.dropped / total) * 100 : 0;
  // Judged by dropped frames, not by the rate: a ProMotion screen slows to 60 Hz or less on purpose when
  // little is moving, and that's smooth. Only a rate too low to look smooth counts on its own.
  return dropPct >= 20 ? 'bad' : dropPct >= 6 || fps.value < 30 ? 'warn' : 'good';
}
function rate(n) {
  if (n == null) return '–';
  if (n < 1024) return '0 KB/s';
  if (n < 1048576) return `${Math.round(n / 1024)} KB/s`;
  const mb = n / 1048576;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
}
function renderLive() {
  if (!snap) return;
  // In an app's view, Graphics, Network and Disk are that app's own (all its parts added up), not the
  // whole Mac's. FPS stays the screen's: it's measured by this panel, so it can't be any one app's.
  const a = view === 'app' && !picking ? appByKey(appKey) : null;
  const L = (a ? a.live : snap.live) || {}, hz = snap.display?.hz;
  const who = a ? (a.system ? 'the background' : short(a.name)) : null;
  const fl = fpsLevel();
  const gpuSub = a ? (a.gpu ? `${bytes(a.gpu)} held` : 'of the GPU') : L.gpuMem ? `${bytes(L.gpuMem)} used` : 'GPU';
  const cells = [
    { k: 'FPS', v: fps.value == null ? '–' : `${fps.value}`, sub: fps.value == null ? 'measuring' : fl === 'good' ? `smooth${hz ? ` · ${hz} Hz` : ''}` : `${fps.dropped} dropped`, lv: fl,
      tip: `Your screen, not one app: frames this panel got in the last second${hz ? `, on a ${hz} Hz screen` : ''}. ${fps.dropped} dropped. About ${fps.frameMs ? fps.frameMs.toFixed(1) : '–'} ms a frame.` },
    { k: 'Graphics', v: L.gpu == null ? '–' : `${L.gpu}%`, sub: gpuSub, lv: L.gpu == null ? 'good' : lvl(L.gpu, 70, 92),
      tip: a ? `How much of the graphics chip’s (GPU’s) time ${who} is using.` : 'How busy the graphics chip (GPU) is, and the memory its work is holding.' },
    { k: 'Network', v: `↓ ${rate(L.down)}`, sub: `↑ ${rate(L.up)}`, lv: 'good',
      tip: a ? `What ${who} is downloading (↓) and uploading (↑), across all its parts.` : 'Coming in (↓) and going out (↑), across Wi-Fi, Ethernet and everything else.' },
    { k: 'Disk', v: `R ${rate(L.read)}`, sub: `W ${rate(L.write)}`, lv: 'good',
      tip: a ? `What ${who} is reading from (R) and writing to (W) your storage.${L.diskPartial ? ' macOS’s protected tasks can’t be seen, so they aren’t counted.' : ''}` : 'Read from (R) and written to (W) your storage.' },
  ];
  const box = $('live');
  if (box.children.length !== cells.length) box.innerHTML = cells.map(() => '<div class="cell"><small></small><b></b><span></span></div>').join('');
  cells.forEach((c, i) => {
    const el = box.children[i];
    el.className = `cell ${c.lv}`;
    el.title = c.tip;
    const [k, v, sub] = el.children;
    if (k.textContent !== c.k) k.textContent = c.k;
    if (v.textContent !== c.v) v.textContent = c.v;
    if (sub.textContent !== c.sub) sub.textContent = c.sub;
  });
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
  if (a?.system) return { level: 'good', title: 'The background is running fine', sub: 'macOS and your apps’ helpers are behaving.' };
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
  const parts = `${a.procs} part${a.procs === 1 ? '' : 's'}`;
  const sub = a.system ? 'macOS and your apps’ helpers' : a.awake.length ? 'Keeping your Mac awake' : a.self ? 'That’s us' : a.kind === 'menubar' ? `Menu bar app · ${parts}` : parts;
  const pl = plugFor(a);
  const mark = pl ? `<i class="pm ${pl.on ? esc(pl.status.tone) : 'off'}" title="Plugged in: ${esc(pl.status.detail || pl.status.text)}"></i>` : '';
  return `<button class="rowb" data-key="${esc(a.key)}" data-rk="${esc(a.key)}" style="--d:${i * 30}ms">${appIcon(a)}<span class="nm">${esc(a.name)}${mark}<small>${esc(pl ? `Plugged in · ${pl.on ? pl.status.detail || 'Active' : 'Inactive'}` : sub)}</small></span>
    <span class="meter ${lv}"><i style="width:${width}%"></i></span><span class="num"><b>${share < 1 && share > 0 ? '<1' : Math.round(share)}%</b> · ${bytes(a.mem)}</span></button>`;
}
// A background category: what it is, and the busiest things in it. `link`: clicking it opens Background.
const CAT_ICON = {
  kernel: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>',
  helpers: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><path d="M16.5 13.5v6M13.5 16.5h6"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  sync: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"/>',
  photos: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
  backup: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/>',
  update: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  security: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
  ai: '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/>',
  sound: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
  network: '<path d="M2.5 9a14 14 0 0 1 19 0M6 12.5a9 9 0 0 1 12 0M9.5 16a4 4 0 0 1 5 0"/><circle cx="12" cy="19" r=".6"/>',
  dev: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"/>',
  other: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
};
function partHTML(p, i, max, link) {
  const lv = lvl(p.cpu, 15, 35);
  const width = Math.max(p.cpu > 0.3 ? 4 : 0, Math.min(100, (p.cpu / max) * 100));
  const names = (p.top || []).filter((t) => t.cpu >= 0.1 || t.mem >= 50 * 1048576).slice(0, 2).map((t) => (t.count > 1 ? `${t.name} ×${t.count}` : t.name));
  const sub = names.length ? names.join(', ') : `${p.count} task${p.count === 1 ? '' : 's'}, all quiet`;
  const tag = link ? `button class="rowb" data-key="macos"` : 'div class="rowb static"';
  return `<${tag} data-rk="part:${esc(p.id)}" style="--d:${i * 30}ms" title="${esc(`${p.label} ${p.about}. ${p.count} task${p.count === 1 ? '' : 's'}.`)}"><svg class="macic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CAT_ICON[p.id] || CAT_ICON.other}</svg>
    <span class="nm">${esc(p.label)}<small>${esc(sub)}</small></span>
    <span class="meter ${lv}"><i style="width:${width}%"></i></span><span class="num"><b>${p.cpu < 1 && p.cpu > 0 ? '<1' : Math.round(p.cpu)}%</b> · ${bytes(p.mem)}</span></${link ? 'button' : 'div'}>`;
}
// Single processes, busiest first: in % of one core, like Activity Monitor. The app's or background's own
// in their views. Clicking one that belongs to an app opens that app's view.
function procRowHTML(p, i, max, link) {
  const lv = p.avg >= 80 ? 'bad' : p.avg >= 35 ? 'warn' : 'good';
  const width = Math.max(4, Math.min(100, (p.avg / max) * 100));
  const app = p.ownerKey ? appByKey(p.ownerKey) : null;
  const icon = app ? appIcon(app) : `<svg class="macic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CAT_ICON[p.cat] || CAT_ICON.other}</svg>`;
  const flags = [p.steady ? 'looks stuck' : null, p.busyFor >= 30 ? `busy ${mins(p.busyFor)}` : null, p.idle && p.avg >= 20 ? 'app not in use' : null].filter(Boolean);
  const where = p.ownerName ? (p.main ? 'The app itself' : `Part of ${short(p.ownerName)}`) : p.helperOf ? `From ${p.helperOf}` : p.catLabel;
  const sub = [where, ...flags].join(' · ');
  const tag = link && p.ownerKey ? `button class="rowb" data-key="${esc(p.ownerKey)}"` : 'div class="rowb static"';
  const tip = `${p.exe}\npid ${p.pid} · ${p.mine ? 'yours' : 'runs as macOS'} · ${mins(p.cpuTime)} of processor time so far`;
  return `<${tag} data-rk="proc:${p.pid}" style="--d:${i * 30}ms" title="${esc(tip)}">${icon}<span class="nm">${esc(p.name)}<small>${esc(sub)}</small></span>
    <span class="meter ${lv}"><i style="width:${width}%"></i></span><span class="num"><b>${p.avg}%</b> core</span></${tag.startsWith('button') ? 'button' : 'div'}>`;
}
function renderProcs(a) {
  const all = (snap.procs || []).filter((p) => !p.self);
  const list = (a ? all.filter((p) => (a.system ? !p.ownerKey : p.ownerKey === a.key)) : all).filter((p) => p.avg >= 1).slice(0, a ? 6 : 5);
  // An app with only one busy part says nothing its own row doesn't.
  const show = list.length && !(a && !a.system && list.length === 1 && list[0].main && !extreme(list[0]));
  $('procBox').hidden = !show;
  if (!show) return;
  const hogs = all.filter(extreme).length;
  $('procNote').textContent = hogs ? `${hogs} burning it` : '% of one core';
  const max = Math.max(100, ...list.map((p) => p.avg));
  syncRows($('procRows'), list.map((p, i) => procRowHTML(p, i, max, !a)).join(''));
}

// The background categories worth showing in the whole Mac's view: only ones doing real work.
const bigCat = (p) => p.cpu >= 1 || p.core >= 15 || p.mem >= 1.5 * GB;
function renderList(a) {
  const box = $('rows');
  let html;
  let bg = '';
  if (!a) {
    // Apps first: that's what you can do something about. The background comes after, as categories, and
    // only the ones doing real work.
    const apps = snap.apps.filter((x) => !x.system);
    const list = showAll ? apps : apps.slice(0, 5);
    const sys = snap.apps.find((x) => x.system);
    const big = (sys?.parts || []).filter(bigCat).slice(0, 4);
    const max = Math.max(10, ...list.map((x) => recent(x.history, 2)), ...big.map((p) => p.cpu));
    $('listTitle').textContent = 'Busiest apps';
    $('listNote').textContent = `${snap.appCount} open`;
    html = list.map((x, i) => rowHTML(x, i, max)).join('') + (apps.length > 5 ? `<button class="more" id="moreBtn" data-rk="more">${showAll ? 'Show fewer' : `Show all ${apps.length}`}</button>` : '');
    if (sys) {
      const quiet = sys.parts.length - big.length;
      $('bgNote').textContent = `${Math.round(recent(sys.history, 2) * 10) / 10}% · ${bytes(sys.mem)}`;
      bg = big.map((p, i) => partHTML(p, i, max, true)).join('') +
        `<button class="more" data-key="macos" data-rk="bgall">${big.length ? `See all ${sys.parts.length}${quiet ? ` (${quiet} quiet)` : ''}` : `All ${sys.parts.length} quiet · see them`}</button>`;
    }
  } else if (a.system) {
    const parts = a.parts.slice(0, showAll ? a.parts.length : 6);
    const max = Math.max(10, ...parts.map((p) => p.cpu));
    $('listTitle').textContent = 'What’s running in the background';
    $('listNote').textContent = `${a.procs} tasks`;
    html = parts.map((p, i) => partHTML(p, i, max, false)).join('') + (a.parts.length > 6 ? `<button class="more" id="moreBtn" data-rk="more">${showAll ? 'Show fewer' : `Show all ${a.parts.length}`}</button>` : '');
  }
  $('listBox').hidden = !html;
  $('bgBox').hidden = !bg;
  if (bg) syncRows($('bgRows'), bg);
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
    const b = s.battery, c = s.chip, d = s.display;
    rows = [
      ['Chip', c ? c.model.replace(/^Apple /, '') : '–'],
      ['Cores', c?.fast && c?.efficient ? `${c.fast} fast + ${c.efficient} efficient` : `${s.cores}`],
      ['Load (1·5·15 min)', s.load ? s.load.map((v) => v.toFixed(1)).join(' · ') : '–'],
      ['Tasks running', `${s.procCount}`],
      ...(s.procs?.[0] ? [['Busiest task', `${s.procs[0].name.length > 16 ? `${s.procs[0].name.slice(0, 15)}…` : s.procs[0].name} · ${s.procs[0].avg}%`]] : []),
      ['Memory used', `${bytes(s.mem.used)} of ${bytes(s.mem.total)}`],
      ['Apps · wired', `${bytes(s.mem.app)} · ${bytes(s.mem.wired)}`],
      ['Compressed', bytes(s.mem.compressed)],
      ['Cached files', bytes(s.mem.cached)],
      ['Spilled to storage', s.mem.swapUsed ? bytes(s.mem.swapUsed) : 'None'],
      ['Memory pressure', { normal: 'Normal', warn: 'Tight', critical: 'Critical' }[s.mem.pressure]],
    ];
    if (s.disk) rows.push(['Storage free', `${bytes(s.disk.free)} of ${bytes(s.disk.total)}`]);
    if (d) rows.push(['Screen', `${d.hz ? `${d.hz} Hz` : ''}${d.hz && d.width ? ' · ' : ''}${d.width ? `${d.width}×${d.height}` : ''}${d.count > 1 ? ` (${d.count} screens)` : ''}`]);
    if (b) {
      rows.push(['Battery health', b.health != null ? `${b.health}%` : '–'], ['Charge cycles', b.cycles != null ? `${b.cycles}` : '–']);
      if (b.temp) rows.push(['Battery temp', `${b.temp.toFixed(1)}°C`]);
    }
    rows.push(['Heat', HEAT_WORD[s.heat?.state] || (s.heat?.throttled ? 'Slowing down to cool' : 'Normal')]);
    rows.push(['Running for', days(s.uptime)]);
  } else if (!a.system) {
    const one = Math.round(recent(a.history, 2) * s.cores);
    rows = [
      ['Uses now', `${Math.round(recent(a.history, 2))}% of your Mac`],
      ['Of one core', `${one}%`],
      ['Memory', bytes(a.mem)],
      ['Of your memory', `${Math.round((a.mem / s.mem.total) * 100)}%`],
      ...(a.gpu ? [['Graphics (GPU)', `${bytes(a.gpu)} · ${a.gpu > memLimits(a, s).gpu ? 'High' : 'Normal'}`]] : []),
      ['Parts running', `${a.procs}`],
      ['Kind', a.kind === 'menubar' ? 'Menu bar app' : 'App'],
      ['Keeps Mac awake', a.awake.length ? 'Yes' : 'No'],
    ];
  } else {
    rows = [
      ['Uses now', `${Math.round(recent(a.history, 2) * 10) / 10}% of your Mac`],
      ['Memory', bytes(a.mem)],
      ['Tasks running', `${a.procs}`],
      ['Busy groups', `${a.parts.filter(bigCat).length} of ${a.parts.length}`],
    ];
  }
  if (!snap.memExact) rows.push(['Memory figures', 'Rough for now']);
  $('factBox').hidden = !rows.length;
  $('facts').innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('');
}

const HEAT_WORD = { nominal: 'Normal', fair: 'Warm', serious: 'Hot, slowing down', critical: 'Very hot, slowing down' };

const CHIP_ICON = {
  plug: '<path d="M3 12h5"/><rect x="8" y="7" width="8" height="10" rx="2.5"/><path d="M16 10h4M16 14h4"/>',
  plugin: '<path d="M3 12h5"/><rect x="8" y="7" width="8" height="10" rx="2.5"/><path d="M16 10h4M16 14h4"/>',
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
    ...(snap?.pluginOn ? [plugFor(a) ? { label: 'Open plugin', kind: 'plugin', app: a } : { label: 'Plug in', kind: 'plug', app: a }] : []),
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

// ---------- plugins: what each one is doing to its app ----------
const ASPECT_WORD = { cpu: 'Processor', ram: 'Memory', net: 'Network', out: 'Sound', mic: 'Microphone' };
const gbs = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);
function plugRules(p) {
  const out = [];
  for (const k of ['cpu', 'ram', 'net', 'out', 'mic']) {
    const L = p.levels[k];
    if (L === 10 || L === 0) continue;
    out.push(`${ASPECT_WORD[k]} ${L < 10 ? `${L}/10` : L === 11 ? 'boosted' : 'in overdrive'}`);
  }
  if (p.route.device) out.push(`own network${p.route.name ? ` (${p.route.name})` : ''}`);
  if (p.focus.on) out.push('Focus mode');
  return out;
}
function plugNow(p) {
  if (!p.on) return 'Off. Nothing is changed.';
  if (!p.running) return 'Not open. It starts working when the app opens.';
  const bits = [];
  if (p.throttle > 0.05) bits.push(`pausing it ${Math.round(p.throttle * 100)}% of the time`);
  if (p.quieted) bits.push(`${p.quieted} part${p.quieted === 1 ? '' : 's'} of other apps quieted`);
  if (p.over) bits.push('over its memory line');
  if (p.focusLive) bits.push('Focus on');
  if (p.routed) bits.push(p.route.up ? `going out ${p.route.name || 'its own network'}` : 'its network is off');
  const live = `${p.live.cpu < 0.5 ? 'almost no processor' : `${(Math.round(p.live.cpu) / 10).toFixed(1)} shares of processor`}, ${gbs(p.live.mem)}`;
  return `${bits.length ? `${bits.join(', ')}. ` : ''}Using ${live}.`.replace(/^./, (c) => c.toUpperCase());
}
function plugRowHTML(p, i) {
  const pips = ['cpu', 'ram', 'net', 'out', 'mic'].map((k) => {
    const L = p.levels[k];
    return `<i class="${L >= 11 ? 'b' : L >= 1 && L < 10 ? 'l' : ''}" style="height:${L >= 1 && L < 10 ? 3 + L : L >= 11 ? 14 : 5}px"></i>`;
  }).join('');
  const rules = plugRules(p);
  const ic = appIcon(p);
  return `<button class="plugrow ${p.on ? esc(p.status.tone) : 'off'}" data-plug="${esc(p.id)}" data-rk="plug:${esc(p.id)}" style="--d:${i * 30}ms">
    ${ic}<span class="pt"><b>${esc(p.name)}<i class="pled"></i><em>${esc(p.on ? p.status.detail || p.status.text : 'Inactive')}</em></b><small>${esc(rules.length ? rules.join(', ') : 'No rules yet: everything free')}</small><small class="now">${esc(plugNow(p))}</small></span>
    <span class="ppips">${pips}</span></button>`;
}
function renderPlugins(a) {
  const all = snap.plugins || [];
  // Icons come from the busiest-apps list, which already has them.
  const withIcon = (p) => ({ ...p, icon: snap.apps.find((x) => (p.bundle ? x.bundle === p.bundle : x.name === p.name))?.icon || null });
  const list = (a ? all.filter((p) => p === plugFor(a)) : all).map(withIcon);
  $('plugBox').hidden = !list.length;
  if (!list.length) return;
  $('plugTitle').textContent = a ? 'Its plugin' : 'Plugins';
  $('plugNote').textContent = a ? '' : `${all.filter((p) => p.on).length} on`;
  syncPlugs(list.map(plugRowHTML).join(''));
}
function syncPlugs(html) {
  const box = $('plugRows');
  if (box.dataset.sig === html) return;
  box.dataset.sig = html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const old = new Map([...box.children].map((el) => [el.dataset.rk, el]));
  const out = [...tmp.children].map((el) => {
    const was = old.get(el.dataset.rk);
    if (!was) { el.classList.add('enter'); return el; }
    old.delete(el.dataset.rk);
    was.className = el.className;
    const ic = el.firstElementChild, oic = was.firstElementChild;
    if (ic.tagName !== oic.tagName || ic.getAttribute('src') !== oic.getAttribute('src')) oic.replaceWith(ic); // its icon arrived
    was.querySelector('.pt').innerHTML = el.querySelector('.pt').innerHTML;
    [...was.querySelectorAll('.ppips i')].forEach((pip, k) => { const n = el.querySelectorAll('.ppips i')[k]; pip.className = n.className; pip.style.height = n.style.height; });
    return was;
  });
  for (const el of old.values()) el.remove();
  out.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
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
  renderLive();
  const RANK = { bad: 0, warn: 1, tip: 2, ok: 3 }; // reassurances (\u201cnormal for a browser\u201d) go last
  renderFixes(list.sort((x, y) => RANK[x.level] - RANK[y.level]));
  renderPlugins(a);
  renderList(a);
  renderProcs(a);
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
  $('pillFps').textContent = fps.value == null ? '–' : `${fps.value}`;
  $('pillFpsBox').className = `stat fps ${fpsLevel()}`;
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
  if (act.kind === 'plug' || act.kind === 'plugin') { openPlugin(act.app, act.kind === 'plug'); return; }
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
  const r = await scrawl.invoke('debug:fix', act.kind, act.proc ? { pid: act.proc.pid, exe: act.proc.exe } : act.app ? { pid: act.app.pid } : null);
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
async function openPlugin(a, add) {
  const r = await scrawl.invoke('debug:plugin', add ? 'add' : 'open', { bundle: a.bundle, name: a.name, path: a.path });
  if (!r?.ok) toast('Turn Plugin on in Pane’s settings first.', true);
}
document.addEventListener('click', (e) => {
  const pr = e.target.closest('[data-plug]');
  if (pr) { const p = (snap?.plugins || []).find((x) => x.id === pr.dataset.plug); if (p) openPlugin(p, false); return; }
  const b = e.target.closest('[data-act]');
  if (b) { const act = findAct(b.dataset.act); if (act) runAct(b, b.dataset.act, act); return; }
  if (!e.target.closest('.sure')) document.querySelectorAll('.sure').forEach(unsure);
  const row = e.target.closest('.rowb[data-key], .more[data-key]');
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
function resetBoxes() { for (const id of ['rows', 'bgRows', 'procRows', 'fixes', 'tiles']) { $(id).dataset.keys = ''; $(id).dataset.sig = ''; $(id).dataset.view = ''; } }
$('appTab').addEventListener('click', (e) => {
  if (e.target.closest('#chev') || view === 'app') { picking = !picking; $('pickRows').dataset.keys = ''; render(); return; }
  view = 'app'; picking = false; showAll = false; resetBoxes(); render();
});
$('macTab').addEventListener('click', () => { if (view === 'mac' && !picking) return; view = 'mac'; picking = false; showAll = false; resetBoxes(); render(); });
$('pickBack').addEventListener('click', () => { picking = false; render(); });

// ---------- folding up, closing ----------
function setMini(on) {
  if (mini === on) return;
  mini = on;
  $('card').hidden = on;
  $('pill').hidden = !on;
  scrawl.send('debug:mini', on);
  fit();
}
$('mini').addEventListener('click', () => setMini(true));
// The pill moves wherever you drag it, from anywhere on it. A press that barely moves is still a click
// (so the middle still opens the panel); one that travels is a drag, and its click is swallowed.
const pillDrag = { id: null, x: 0, y: 0, moved: false };
// The pointer is only captured once it really moves: captured from the press, the click would land on the
// pill itself rather than the button under it, and the pill could never open again.
$('pill').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('#pillClose')) return;
  Object.assign(pillDrag, { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false });
  scrawl.send('debug:drag', 'start', { x: e.screenX, y: e.screenY });
});
$('pill').addEventListener('pointermove', (e) => {
  if (e.pointerId !== pillDrag.id) return;
  if (!pillDrag.moved && Math.hypot(e.screenX - pillDrag.x, e.screenY - pillDrag.y) < 4) return;
  if (!pillDrag.moved) { try { $('pill').setPointerCapture(e.pointerId); } catch {} }
  pillDrag.moved = true;
  $('pill').classList.add('dragging');
  scrawl.send('debug:drag', 'move', { x: e.screenX, y: e.screenY });
});
const endPillDrag = (e) => {
  if (e.pointerId !== pillDrag.id) return;
  pillDrag.id = null;
  $('pill').classList.remove('dragging');
  if (pillDrag.moved) scrawl.send('debug:drag', 'end', { x: e.screenX, y: e.screenY });
  else if (e.type === 'pointerup' && !e.target.closest('#pillClose')) setMini(false); // a press that stayed put opens it, from anywhere on the pill
};
$('pill').addEventListener('pointerup', endPillDrag);
$('pill').addEventListener('pointercancel', endPillDrag);
$('pill').addEventListener('click', (e) => { if (pillDrag.moved) { e.stopPropagation(); e.preventDefault(); pillDrag.moved = false; } }, true);
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
scrawl.on('debug:shown', () => {
  // Number the parts for their rise-in, then fill the gauges once the card has mostly landed.
  [document.querySelector('.card .bar'), $('seg'), ...$('main').children].forEach((el, i) => el?.style.setProperty('--i', i));
  document.body.classList.add('shown');
  setTimeout(() => document.body.classList.add('filled'), 320);
});
// Closing: play the way out, then say so (the main process closes the window, or does after a moment anyway).
scrawl.on('debug:leave', () => {
  document.body.classList.add('leaving');
  setTimeout(() => scrawl.send('debug:gone'), 260);
});
scrawl.on('debug:settings', (s) => { cfg = s; resetBoxes(); render(); fit(); });
// "Watch in Debug" from a plugin's menu: show that app.
scrawl.on('debug:focus', (key) => { if (appByKey(key)) choose(key); });
