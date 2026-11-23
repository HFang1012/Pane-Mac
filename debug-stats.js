// Debug's eyes and hands: how busy the Mac is, which apps are making it so, and the handful of fixes it
// can run. Everything here uses tools that need no password and no extra permission (ps, lsappinfo,
// vm_stat, sysctl, pmset, ioreg). Fixes are a fixed list: the page asks for one by name, never a command.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
});
const HISTORY = 40; // samples kept per app, for spotting one that stays busy
const TRAIL_MS = 15000; // the graphs show the last 15 seconds

// ---------- apps ----------
// Running apps, from lsappinfo: the ones with a Dock icon ("Foreground").
function parseApps(text) {
  const apps = [];
  for (const block of text.split(/\n\s*\d+\) /)) {
    const name = /^"([^"]*)"/.exec(block.trim())?.[1];
    const pid = Number(/pid = (\d+)/.exec(block)?.[1]);
    const type = /type="([^"]+)"/.exec(block)?.[1];
    if (!name || !pid || type !== 'Foreground') continue;
    apps.push({
      name,
      pid,
      bundle: /bundleID="([^"]+)"/.exec(block)?.[1] || null,
      path: /bundle path="([^"]+)"/.exec(block)?.[1] || null,
    });
  }
  return apps;
}

// The app in front right now: { pid, bundle, name, path } or null.
async function frontApp() {
  const asn = (await run('lsappinfo', ['front'])).trim();
  if (!asn) return null;
  const out = await run('lsappinfo', ['info', '-only', 'pid', '-only', 'bundleid', '-only', 'name', '-only', 'bundlepath', asn]);
  const pid = Number(/"pid"=(\d+)/.exec(out)?.[1]);
  if (!pid) return null;
  return {
    pid,
    bundle: /"CFBundleIdentifier"="([^"]+)"/.exec(out)?.[1] || null,
    name: /"LSDisplayName"="([^"]+)"/.exec(out)?.[1] || null,
    path: /"LSBundlePath"="([^"]+)"/.exec(out)?.[1] || null,
  };
}

// ---------- processes ----------
// "12:34.56" (minutes:seconds) or "1-02:03:04" (days-hours:minutes:seconds) → seconds.
function cpuSeconds(t) {
  let days = 0;
  if (t.includes('-')) { const [d, rest] = t.split('-'); days = Number(d); t = rest; }
  const parts = t.split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s + days * 86400;
}
function parsePs(text) {
  const procs = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), time: cpuSeconds(m[4]), rss: Number(m[5]) * 1024, exe: m[6].trim() });
  }
  return procs;
}

// System processes worth a word when they're busy. Each has a plain name and what it's up to.
const SYSTEM = {
  WindowServer: { label: 'Screen drawing', about: 'draws every window and animation on your screens' },
  mds_stores: { label: 'Spotlight', about: 'is indexing your files for search' },
  mds: { label: 'Spotlight', about: 'is indexing your files for search' },
  mdworker_shared: { label: 'Spotlight', about: 'is indexing your files for search' },
  mdworker: { label: 'Spotlight', about: 'is indexing your files for search' },
  photoanalysisd: { label: 'Photos', about: 'is scanning your photo library for faces and places' },
  mediaanalysisd: { label: 'Photos', about: 'is scanning your photo library' },
  backupd: { label: 'Time Machine', about: 'is backing up' },
  bird: { label: 'iCloud Drive', about: 'is syncing your files' },
  cloudd: { label: 'iCloud', about: 'is syncing' },
  fileproviderd: { label: 'iCloud Drive', about: 'is syncing your files' },
  softwareupdated: { label: 'Software Update', about: 'is downloading an update' },
  coreaudiod: { label: 'Sound', about: 'plays sound for every app' },
  kernel_task: { label: 'macOS', about: 'is keeping your Mac cool by slowing it down' },
  corespotlightd: { label: 'Spotlight', about: 'is indexing for search' },
  syspolicyd: { label: 'Security checks', about: 'is checking a new app' },
  XprotectService: { label: 'Malware scan', about: 'is checking files for malware' },
};

// ---------- the sampler ----------
const S = {
  prev: null, // { at, times: Map(pid -> cpu seconds), cpus }
  history: [], // whole-Mac CPU, 0-100
  appHistory: new Map(), // app key -> [cpu share, 0-100]
  slow: { at: 0, data: null }, // battery, disk, heat, sleep blockers: every 10 s
  icons: new Map(), // bundle path -> data URL (or null while it loads)
};

function cpuTotals() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// The whole Mac's CPU, once a second, always (os.cpus() is cheap: no process to start). So the graph
// already has the last 15 seconds the moment Debug opens.
const tick = { prev: null, buf: [] };
function tickCpu() {
  const c = cpuTotals();
  if (tick.prev) {
    const di = c.idle - tick.prev.idle, dt = c.total - tick.prev.total;
    if (dt > 0) tick.buf.push({ t: Date.now(), v: Math.round(Math.max(0, Math.min(100, (1 - di / dt) * 100)) * 10) / 10 });
    if (tick.buf.length > 60) tick.buf.shift();
  }
  tick.prev = c;
}
// main.js calls tickCpu from the once-a-second timer it already has, so Debug adds no timer of its own.
function startTicker() {
  if (!tick.prev) tickCpu();
}
const trailOf = (points, now) => points.filter((p) => p.t >= now - TRAIL_MS - 1500);

async function memory() {
  const [vm, sys] = await Promise.all([
    run('vm_stat', []),
    run('sysctl', ['-n', 'hw.memsize', 'hw.pagesize', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', 'vm.swapusage']),
  ]);
  const [memsize, pagesize, level, freePct, swap] = sys.trim().split('\n');
  const page = Number(pagesize) || 16384;
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] || 0) * page;
  const total = Number(memsize) || os.totalmem();
  // Like Activity Monitor's "Memory Used": what apps hold, plus wired and compressed memory.
  const used = Math.min(total, pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor'));
  const mb = (k) => Number(new RegExp(`${k} = ([\\d.]+)M`).exec(swap || '')?.[1] || 0) * 1048576;
  return {
    total,
    used: used > 0 ? used : total - os.freemem(),
    pressure: { 1: 'normal', 2: 'warn', 4: 'critical' }[Number(level)] || 'normal',
    freePct: Number(freePct) || null,
    swapUsed: mb('used'),
    swapTotal: mb('total'),
  };
}

async function battery() {
  const [batt, io] = await Promise.all([run('pmset', ['-g', 'batt']), run('ioreg', ['-rn', 'AppleSmartBattery'])]);
  const m = /(\d+)%;\s*([^;]+);\s*([^\s]+)?/.exec(batt);
  if (!m) return null; // a Mac without a battery
  const state = m[2].trim();
  const rem = /^(\d+):(\d+)$/.exec(m[3] || '');
  const num = (k) => { const v = new RegExp(`"${k}" = (\\d+)`).exec(io)?.[1]; return v == null ? null : Number(v); };
  const design = num('DesignCapacity'), max = num('AppleRawMaxCapacity');
  const temp = num('Temperature');
  return {
    pct: Number(m[1]),
    plugged: /AC Power/.test(batt),
    charging: state === 'charging',
    full: state === 'charged',
    remaining: rem && !(rem[1] === '0' && rem[2] === '00') ? Number(rem[1]) * 60 + Number(rem[2]) : null,
    health: design && max ? Math.min(100, Math.round((max / design) * 100)) : null,
    cycles: num('CycleCount'),
    temp: temp ? Math.round(temp / 10) / 10 : null,
    failing: (num('PermanentFailureStatus') || 0) !== 0,
  };
}

function disk() {
  for (const p of ['/System/Volumes/Data', '/']) {
    try {
      const s = fs.statfsSync(p);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {}
  }
  return null;
}

async function heat() {
  const out = await run('pmset', ['-g', 'therm']);
  const limit = Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(out)?.[1] || 100);
  const level = /thermal warning level set to (\d+)/i.exec(out)?.[1];
  return { throttled: limit < 100 || (level != null && Number(level) > 0), limit };
}

// Apps keeping the Mac awake (a video playing, a download). "Created for PID" names the app behind
// a system process holding one for it (sound, mostly).
async function sleepBlockers() {
  const out = await run('pmset', ['-g', 'assertions']);
  const list = [];
  const lines = out.split('\n');
  lines.forEach((line, i) => {
    const m = /pid (\d+)\(([^)]+)\):.*?(PreventUserIdleDisplaySleep|NoDisplaySleepAssertion|PreventUserIdleSystemSleep|NoIdleSleepAssertion|PreventSystemSleep)\s+named: "([^"]*)"/.exec(line);
    if (!m) return;
    let pid = Number(m[1]);
    const forPid = /Created for PID: (\d+)/.exec(lines[i + 1] || '')?.[1];
    if (forPid) pid = Number(forPid);
    else if (['powerd', 'coreaudiod', 'WindowServer'].includes(m[2])) return;
    list.push({ pid, display: /Display/.test(m[3]), what: m[4] });
  });
  return list;
}

async function slowStats() {
  const now = Date.now();
  if (S.slow.data && now - S.slow.at < 10000) return S.slow.data;
  const [b, h, s] = await Promise.all([battery(), heat(), sleepBlockers()]);
  S.slow = { at: now, data: { battery: b, heat: h, blockers: s, disk: disk() } };
  return S.slow.data;
}

const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY) arr.shift(); return arr; };

// One look at the whole Mac. `selfPids` are Pane's own processes (kept apart, as "Pane").
async function sample({ selfPid } = {}) {
  startTicker();
  const [psOut, appsOut, mem, slow] = await Promise.all([
    run('ps', ['-Axo', 'pid=,ppid=,pcpu=,time=,rss=,comm=']),
    run('lsappinfo', ['list']),
    memory(),
    slowStats(),
  ]);
  const now = Date.now();
  const procs = parsePs(psOut);
  const apps = parseApps(appsOut);
  const cores = os.cpus().length || 1;
  const totals = cpuTotals();

  // Per-process CPU since the last look, in % of one core. Without a recent look, ps's own average.
  const prev = S.prev;
  const fresh = prev && now - prev.at < 15000 && now - prev.at > 200;
  const dt = fresh ? (now - prev.at) / 1000 : 0;
  const cpuOf = (p) => {
    if (!fresh) return p.pcpu;
    const before = prev.times.get(p.pid);
    if (before == null || p.time < before) return p.pcpu;
    return Math.max(0, ((p.time - before) / dt) * 100);
  };
  let total;
  if (fresh) {
    const di = totals.idle - prev.cpus.idle, dtot = totals.total - prev.cpus.total;
    total = dtot > 0 ? Math.max(0, Math.min(100, (1 - di / dtot) * 100)) : 0;
  } else {
    total = Math.min(100, [...procs.values()].reduce((s, p) => s + p.pcpu, 0) / cores);
  }
  S.prev = { at: now, times: new Map([...procs.values()].map((p) => [p.pid, p.time])), cpus: totals };
  push(S.history, Math.round(total * 10) / 10);
  // The 1-second trail, with this look's number as its newest point.
  const cpuTrail = trailOf([...tick.buf.filter((p) => p.t < now - 400), { t: now, v: Math.round(total * 10) / 10 }], now);

  // Which app each process belongs to: inside its .app bundle, or a child of it.
  const byPid = new Map(apps.map((a) => [a.pid, a]));
  const roots = apps.filter((a) => a.path).sort((a, b) => b.path.length - a.path.length);
  const safari = apps.find((a) => a.bundle === 'com.apple.Safari');
  const owner = (p) => {
    if (byPid.has(p.pid)) return byPid.get(p.pid);
    const inside = roots.find((a) => p.exe.startsWith(`${a.path}/`));
    if (inside) return inside;
    let q = p;
    for (let i = 0; i < 8 && q && q.ppid > 1; i++) {
      if (byPid.has(q.ppid)) return byPid.get(q.ppid);
      q = procs.get(q.ppid);
    }
    if (safari && /com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(p.exe)) return safari;
    return null;
  };
  const groups = new Map(apps.map((a) => [a.pid, { ...a, cpu: 0, mem: 0, procs: 0 }]));
  const system = new Map(); // process name -> { cpu, mem, count }
  let systemCpu = 0, systemMem = 0;
  for (const p of procs.values()) {
    const c = cpuOf(p);
    const a = owner(p);
    if (a) {
      const g = groups.get(a.pid);
      g.cpu += c; g.mem += p.rss; g.procs++;
      continue;
    }
    const name = path.basename(p.exe);
    systemCpu += c; systemMem += p.rss;
    const s = system.get(name) || { name, cpu: 0, mem: 0, count: 0, pids: [] };
    s.cpu += c; s.mem += p.rss; s.count++; s.pids.push(p.pid);
    system.set(name, s);
  }

  const share = (oneCore) => Math.min(100, oneCore / cores); // % of the whole Mac
  const blockersByPid = new Map();
  for (const b of slow.blockers) {
    const pr = procs.get(b.pid);
    const a = pr ? owner(pr) : byPid.get(b.pid);
    const key = a ? a.pid : null;
    if (key) (blockersByPid.get(key) || blockersByPid.set(key, []).get(key)).push(b.what);
  }
  const live = new Set();
  const list = [...groups.values()].map((g) => {
    const key = g.bundle || g.name;
    live.add(key);
    const hist = push(S.appHistory.get(key) || [], { t: now, v: Math.round(share(g.cpu) * 10) / 10 });
    S.appHistory.set(key, hist);
    return {
      key, pid: g.pid, name: g.name, bundle: g.bundle, path: g.path,
      cpu: Math.round(share(g.cpu) * 10) / 10, core: Math.round(g.cpu), mem: g.mem, procs: g.procs,
      history: hist.map((p) => p.v), trail: trailOf(hist, now), icon: iconFor(g.path), self: g.pid === selfPid,
      awake: [...new Set(blockersByPid.get(g.pid) || [])],
    };
  });
  // The rest of macOS as one entry, with its busiest parts named.
  const sysHist = push(S.appHistory.get('macos') || [], { t: now, v: Math.round(share(systemCpu) * 10) / 10 });
  S.appHistory.set('macos', sysHist);
  live.add('macos');
  for (const k of S.appHistory.keys()) if (!live.has(k)) S.appHistory.delete(k);
  const parts = [...system.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 12).map((s) => ({
    name: s.name, label: SYSTEM[s.name]?.label || null, about: SYSTEM[s.name]?.about || null,
    cpu: Math.round(share(s.cpu) * 10) / 10, core: Math.round(s.cpu), mem: s.mem, count: s.count,
  }));
  list.push({
    key: 'macos', pid: 0, name: 'macOS', bundle: null, path: null, system: true,
    cpu: Math.round(share(systemCpu) * 10) / 10, core: Math.round(systemCpu), mem: systemMem,
    procs: [...system.values()].reduce((n, s) => n + s.count, 0), history: sysHist.map((p) => p.v), trail: trailOf(sysHist, now), icon: null, awake: [], parts,
  });
  list.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);

  const snap = {
    at: now, cores, uptime: os.uptime(),
    cpu: { total: Math.round(total), history: [...S.history], trail: cpuTrail },
    mem, battery: slow.battery, disk: slow.disk, heat: slow.heat,
    apps: list, appCount: apps.length,
  };
  snap.health = health(snap);
  return snap;
}

// ---------- the overall answer: do you need to debug? ----------
// A score out of 100. Each problem takes some off; the reasons say which, worst first.
function health(s) {
  const out = [];
  const hit = (points, reason) => out.push({ points, reason });
  const avg = (a) => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : 0);
  const cpu15 = avg(s.cpu.trail.map((p) => p.v));
  if (cpu15 >= 80) hit(30, 'Processor maxed out');
  else if (cpu15 >= 50) hit(12, 'Processor busy');
  const busy = s.apps.filter((a) => !a.self && !a.system && avg(a.history.slice(-3)) >= 20);
  busy.slice(0, 2).forEach((a) => hit(10, `${a.name} working hard`));
  if (s.mem.pressure === 'critical') hit(40, 'Out of memory');
  else if (s.mem.pressure === 'warn') hit(20, 'Memory tight');
  if (s.mem.swapUsed > Math.max(2 * 1073741824, s.mem.total * 0.15)) hit(10, 'Using storage as memory');
  if (s.disk) {
    const free = s.disk.free / s.disk.total;
    if (free < 0.05 || s.disk.free < 10e9) hit(30, 'Storage nearly full');
    else if (free < 0.1 || s.disk.free < 20e9) hit(15, 'Storage running low');
  }
  const b = s.battery;
  if (b && !b.plugged && b.pct <= 10) hit(20, 'Battery almost empty');
  else if (b && !b.plugged && b.pct <= 20) hit(10, 'Battery low');
  if (b && (b.failing || (b.health != null && b.health < 80))) hit(5, 'Battery worn');
  if (s.heat?.throttled) hit(30, 'Running hot');
  if (s.uptime > 14 * 86400) hit(5, 'Not restarted in a while');
  out.sort((x, y) => y.points - x.points);
  const score = Math.max(0, 100 - out.reduce((n, x) => n + x.points, 0));
  const level = score >= 80 ? 'good' : score >= 55 ? 'warn' : 'bad';
  return {
    score, level,
    label: { good: 'Healthy', warn: 'Worth a look', bad: 'Needs debugging' }[level],
    answer: { good: 'No debugging needed.', warn: 'Maybe. Something’s worth a look.', bad: 'Yes. Something is slowing your Mac down.' }[level],
    reasons: out.map((x) => x.reason),
  };
}

// App icons, read once each and kept. The first look goes out without; the next has it.
let iconLoader = null; // set by main.js: (bundlePath) => Promise<dataURL>
function iconFor(p) {
  if (!p || !iconLoader) return null;
  if (S.icons.has(p)) return S.icons.get(p);
  S.icons.set(p, null);
  iconLoader(p).then((url) => S.icons.set(p, url || null)).catch(() => {});
  return null;
}

// ---------- fixes ----------
const safeId = (s) => typeof s === 'string' && /^[\w.-]+$/.test(s);
const osa = (script, timeout = 15000) => new Promise((resolve) => {
  execFile('osascript', ['-e', script], { timeout }, (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '') }));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return !alive(pid);
};
const permHint = (r) => (/-1743|not allowed|Not authorized/i.test(r.err) ? 'Pane needs permission. Allow it in System Settings › Privacy & Security › Automation.' : null);

const CHROMIUM = ['com.google.Chrome', 'com.google.Chrome.beta', 'com.brave.Browser', 'com.microsoft.edgemac', 'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera'];
const BROWSERS = [...CHROMIUM, 'com.apple.Safari'];
const isBrowser = (bundle) => BROWSERS.includes(bundle);

// Close tabs that show a page already open in another tab (the first one stays). Returns how many went.
async function closeDuplicateTabs(bundle) {
  const safari = bundle === 'com.apple.Safari';
  const script = `
    set seen to {}
    set closed to 0
    set remaining to 0
    tell application id "${bundle}"
      repeat with w in ${safari ? '(every window whose visible is true)' : 'windows'}
        set urls to {}
        try
          set urls to URL of tabs of w
        end try
        set doomed to {}
        repeat with i from 1 to count of urls
          set u to item i of urls
          if u is missing value then
          else if seen contains {u} then
            set end of doomed to i
          else
            set end of seen to u
          end if
        end repeat
        repeat with k from (count of doomed) to 1 by -1
          try
            close tab (item k of doomed) of w
            set closed to closed + 1
          end try
        end repeat
        try
          set remaining to remaining + (count of tabs of w)
        end try
      end repeat
    end tell
    return (closed as text) & " " & (remaining as text)`;
  const r = await osa(script, 20000);
  if (!r.ok) return { ok: false, message: permHint(r) || 'Couldn’t reach the browser’s tabs.' };
  const [closed, left] = r.out.split(' ').map(Number);
  return { ok: true, message: closed ? `Closed ${closed} duplicate tab${closed === 1 ? '' : 's'}. ${left} still open.` : `No duplicates. ${left} tab${left === 1 ? '' : 's'} open.` };
}

const SETTINGS_PANES = {
  storage: 'x-apple.systempreferences:com.apple.settings.Storage',
  battery: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  login: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  display: 'x-apple.systempreferences:com.apple.Accessibility-Settings.extension?Display',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

// Run one fix. `app` is the app it's for, as the page last saw it ({ pid, bundle, name }), checked
// against what's running now. `shell` is Electron's, for opening System Settings and apps.
async function fix(kind, app, { shell, selfPid }) {
  const running = app?.pid ? parseApps(await run('lsappinfo', ['list'])).find((a) => a.pid === app.pid) : null;
  const needApp = ['quit', 'force', 'reopen', 'tabs'].includes(kind);
  if (needApp && !running) return { ok: false, message: 'That app isn’t open anymore.' };
  if (needApp && running.pid === selfPid) return { ok: false, message: 'Quit Pane from its own menu.' };
  const name = running?.name;
  switch (kind) {
    case 'quit': {
      const r = running.bundle && safeId(running.bundle) ? await osa(`tell application id "${running.bundle}" to quit`) : { ok: false };
      if (!r.ok) { try { process.kill(running.pid, 'SIGTERM'); } catch {} }
      const gone = await waitGone(running.pid, 4000);
      return { ok: true, message: gone ? `Quit ${name}.` : `Asked ${name} to quit. It may be waiting for you to save something.` };
    }
    case 'force': {
      try { process.kill(running.pid, 'SIGKILL'); } catch { return { ok: false, message: `Couldn’t force ${name} to quit.` }; }
      await waitGone(running.pid, 2000);
      return { ok: true, message: `Forced ${name} to quit.` };
    }
    case 'reopen': {
      if (!running.bundle || !safeId(running.bundle)) return { ok: false, message: `Couldn’t reopen ${name}.` };
      await osa(`tell application id "${running.bundle}" to quit`);
      if (!(await waitGone(running.pid, 12000))) return { ok: false, message: `${name} didn’t quit. It may be waiting for you to save something.` };
      await run('open', ['-b', running.bundle]);
      return { ok: true, message: `Reopened ${name}. It starts fresh, with less memory.` };
    }
    case 'tabs': {
      if (!isBrowser(running.bundle)) return { ok: false, message: 'That only works for web browsers.' };
      return closeDuplicateTabs(running.bundle);
    }
    case 'finder': await run('killall', ['Finder']); return { ok: true, message: 'Finder restarted.' };
    case 'dock': await run('killall', ['Dock']); return { ok: true, message: 'Dock restarted.' };
    case 'menubar': await run('killall', ['ControlCenter', 'SystemUIServer']); return { ok: true, message: 'Menu bar restarted.' };
    case 'trash': {
      const r = await osa('tell application "Finder" to empty trash', 60000);
      return r.ok ? { ok: true, message: 'Trash emptied.' } : { ok: false, message: permHint(r) || 'Couldn’t empty the Trash.' };
    }
    case 'restart': {
      // The Mac's own "Restart now?" sheet: it asks, and apps get to save first.
      const r = await osa('tell application "loginwindow" to «event aevtrrst»');
      return r.ok ? { ok: true, message: 'Your Mac is asking about restarting.' } : { ok: false, message: 'Use  › Restart… to restart.' };
    }
    case 'activity': await run('open', ['-b', 'com.apple.ActivityMonitor']); return { ok: true, message: 'Opened Activity Monitor.' };
    default:
      if (kind.startsWith('open:') && SETTINGS_PANES[kind.slice(5)]) {
        await shell.openExternal(SETTINGS_PANES[kind.slice(5)]);
        return { ok: true, message: 'Opened System Settings.' };
      }
      return { ok: false, message: 'Unknown fix.' };
  }
}

module.exports = {
  sample, frontApp, fix, isBrowser, startTicker, tickCpu, TRAIL_MS,
  setIconLoader: (fn) => { iconLoader = fn; },
  _test: { parseApps, parsePs, cpuSeconds },
};
