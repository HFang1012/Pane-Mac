// Plugin: what a plugin does to the app it's plugged into. Runs in the main process.
//
// Each plugin holds five "shares" (processor, memory, network, sound out, microphone), each a level 1–12:
//   0     off: Pane leaves it alone (drag the rail all the way left, or reset it)
//   1–9   a limit: that many tenths of your Mac (or of the sound's range, or a step on a speed ladder)
//   10    all of it: no limit, same as off
//   11    boost: the app goes first and busy apps make room
//   12    overdrive: every other app makes room, not just the busy ones. No password needed.
// plus its own network (a route out of one network you pick) and Focus mode.
//
// What Pane actually does, by lever. Everything here works on your own apps without extra permissions,
// except the music players' volumes (Automation):
//   pause bursts       SIGSTOP / SIGCONT, a few times a second, on the app's busy parts (like cpulimit)
//   background QoS     taskpolicy -b: macOS runs it on the efficiency cores and throttles its disk and
//                      network. Undone with taskpolicy -B. Used to quiet a limited app, and other apps for a boost.
//   hiding             NSRunningApplication.hide (Pane's helper): a hidden app naps and its memory compresses
//   volume             AppleScript's "set volume" for the Mac's output and input while the app is in front
//   own network        a SOCKS5 proxy per app (plugin-proxy.js) bound to that network's address
//   Focus mode         other apps quieted, other screens blurred (main.js draws the blur), Mac kept awake
// Everything Pane changes it puts back: when a share goes back to free, the plugin is turned off or
// removed, the app quits, or Pane quits. Pause bursts are also undone if Pane crashes mid-burst (see recover).
const { execFile } = require('child_process');
const os = require('os');
const { Route, networks, freePort } = require('./plugin-proxy.js');

const FREE = 10;
const ASPECTS = ['cpu', 'ram', 'net', 'out', 'mic'];
const MAX = { cpu: 12, ram: 12, net: 11, out: 12, mic: 11 };
// Network limits, bytes a second, for levels 1–9 (10 is free).
const NET_SPEEDS = [0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768].map((k) => k * 1024);
const PLAYERS = ['com.spotify.client', 'com.apple.Music'];
const MY_UID = typeof process.getuid === 'function' ? process.getuid() : -1;
// Never paused or quieted, whatever a plugin says: macOS needs them, or they're Pane.
const PROTECTED = /(^|\/)(launchd|loginwindow|WindowServer|kernel_task|Dock|Finder|SystemUIServer|ControlCenter|NotificationCenter|coreaudiod|cfprefsd|distnoted|lsd|tccd|secd|trustd|Spotlight|mds|mds_stores|universalaccessd)$/;

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '') }));
});
const osa = (script, timeout = 8000) => run('osascript', ['-e', script], timeout);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const safeId = (s) => typeof s === 'string' && /^[\w.-]+$/.test(s);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- the helper: Pane's eyes on windows and apps ----------
// One long-running `pane-files windows` process, asked one line at a time (see native/pane-files.swift).
class Eyes {
  constructor(helperPath, selfPid) { this.helperPath = helperPath; this.selfPid = selfPid; this.proc = null; this.waiting = new Map(); this.n = 0; this.buf = ''; }
  start() {
    if (this.proc) return true;
    const p = this.helperPath?.();
    if (!p) return false;
    try {
      this.proc = require('child_process').spawn(p, ['windows', String(this.selfPid)], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { this.proc = null; return false; }
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let msg = null;
        try { msg = JSON.parse(line); } catch {}
        const q = msg && this.waiting.get(msg.n);
        if (!q) continue; // an answer that came too late: its question already gave up
        this.waiting.delete(msg.n);
        clearTimeout(q.timer);
        q.resolve(msg);
      }
    });
    const gone = () => { this.proc = null; for (const q of this.waiting.values()) { clearTimeout(q.timer); q.resolve(null); } this.waiting.clear(); };
    this.proc.on('exit', gone);
    this.proc.on('error', gone);
    this.proc.stdin.on('error', () => {});
    return true;
  }
  ask(cmd) {
    if (!this.start()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const n = ++this.n;
      this.waiting.set(n, { resolve, timer: setTimeout(() => { this.waiting.delete(n); resolve(null); }, 2000) });
      try { this.proc.stdin.write(`${n} ${cmd}\n`); } catch { this.waiting.delete(n); resolve(null); }
    });
  }
  stop() { try { this.proc?.stdin.end(); this.proc?.kill(); } catch {} this.proc = null; }
}

// ---------- processes ----------
function cpuSeconds(t) {
  let days = 0;
  if (t.includes('-')) { const [d, rest] = t.split('-'); days = Number(d); t = rest; }
  let s = 0;
  for (const p of t.split(':').map(Number)) s = s * 60 + p;
  return s + days * 86400;
}
function parsePs(text) {
  const procs = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), time: cpuSeconds(m[4]), rss: Number(m[5]) * 1024, exe: m[6].trim() });
  }
  return procs;
}
function parseNettop(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /\.(\d+),(\d+),(\d+),?\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const was = map.get(pid) || [0, 0];
    map.set(pid, [was[0] + Number(m[2]), was[1] + Number(m[3])]);
  }
  return map;
}

// Chromium-based apps (browsers and Electron apps) take --proxy-server, so they can get their own network.
const chromiumCache = new Map();
function isChromium(app) {
  if (!app?.path) return false;
  if (chromiumCache.has(app.path)) return chromiumCache.get(app.path);
  let yes = ['com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.canary', 'com.brave.Browser', 'com.microsoft.edgemac', 'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera'].includes(app.bundle);
  if (!yes) {
    try { yes = require('fs').readdirSync(`${app.path}/Contents/Frameworks`).some((f) => /^(Electron|Chromium Embedded|.* Framework)\.framework$/.test(f) && /Electron|Chromium|Chrome|Brave|Edge|Vivaldi|Opera/.test(f)); } catch { yes = false; }
  }
  chromiumCache.set(app.path, yes);
  return yes;
}

// ---------- a plugin, as saved ----------
function cleanFocus(f) {
  return { on: !!f?.on, blur: f?.blur !== false, quiet: f?.quiet !== false, awake: f?.awake !== false, music: !!f?.music };
}
function clean(p) {
  if (!p || typeof p.id !== 'string' || !p.id) return null;
  const out = {
    id: p.id, bundle: safeId(p.bundle) ? p.bundle : null, name: String(p.name || p.id).slice(0, 80), path: typeof p.path === 'string' ? p.path : null,
    on: p.on !== false, made: Number(p.made) || Date.now(), seen: !!p.seen,
    ramAct: ['warn', 'hide'].includes(p.ramAct) ? p.ramAct : 'warn',
    route: { device: typeof p.route?.device === 'string' && /^[\w.]+$/.test(p.route.device) ? p.route.device : null, name: String(p.route?.name || ''), port: Number(p.route?.port) || 0, fallback: p.route?.fallback !== false },
    focus: cleanFocus(p.focus),
  };
  for (const a of ASPECTS) { const v = Math.round(Number(p[a])); out[a] = clamp(Number.isFinite(v) ? v : 0, 0, MAX[a]); }
  // A per-app microphone level needs a virtual microphone driver, which Pane doesn't install. Rather than
  // change the Mac's input level for everything, the share stays off.
  out.mic = 0;
  return out;
}

// A plugin with its off shares (0) read as free (10), for everything that applies the levels.
const eff = (p) => (ASPECTS.some((a) => p[a] === 0) ? { ...p, ...Object.fromEntries(ASPECTS.map((a) => [a, p[a] || FREE])) } : p);

class Engine {
  // deps: { helperPath, selfPid, power (Electron's powerSaveBlocker), notify(title, body), store: { get, set },
  //         safety: { get, set }, onChange(list) }
  constructor(deps) {
    this.d = deps;
    this.eyes = new Eyes(deps.helperPath, deps.selfPid);
    this.plugins = new Map();
    for (const p of (deps.store.get() || [])) { const c = clean(p); if (c) this.plugins.set(c.id, c); }
    this.rt = new Map(); // id -> runtime state (see fresh())
    this.routes = new Map(); // id -> Route
    this.stopped = new Set(); // pids paused right now
    this.yieldedBy = new Map(); // pid -> Set(reason): other apps' parts put in the background for a boost or Focus
    this.watching = new Set(); // plugin ids whose menu is open: sample their network even if it's free
    this.cores = os.cpus().length || 1;
    this.memTotal = os.totalmem();
    this.prev = null; // last ps look: { at, times: Map(pid -> cpu seconds) }
    this.net = { at: 0, prev: null, rates: new Map(), down: new Map(), up: new Map(), busy: false };
    this.apps = [];
    this.front = null;
    this.timer = null;
    this.duty = null;
    this.ticking = false;
    this.powerPrev = null; // the Mac's power mode before overdrive changed it
    this.saveTimer = null;
    this.safetyTimer = null;
    this.lastList = [];
    process.on('exit', () => { for (const pid of this.stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} } });
  }

  // ---------- life ----------
  // Undo anything a crash left behind: parts left paused mid-burst, parts left in the background.
  async recover() {
    const s = this.d.safety.get() || {};
    for (const pid of s.cont || []) if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await this.policy('-B', (s.unbg || []).filter((pid) => Number.isInteger(pid) && alive(pid)));
    this.d.safety.set({ cont: [], unbg: [] });
  }
  start() {
    for (const p of this.plugins.values()) this.syncRoute(p);
    this.recover().finally(() => this.wake());
  }
  wake() {
    if (this.timer || !this.plugins.size || this.suspended) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }
  sleep() { clearInterval(this.timer); this.timer = null; this.prev = null; }
  // Plugin (the tool) turned off in Pane's settings: every plugin lets go of its app, kept for later. Routes
  // stay up (with no speed limit), since a routed app would otherwise lose its connection.
  async suspend(on) {
    this.suspended = !!on;
    if (!on) { this.wake(); return; }
    this.sleep();
    if (this.duty) { clearInterval(this.duty); this.duty = null; }
    this.contAll();
    for (const p of this.plugins.values()) { const r = this.rt.get(p.id); if (r) await this.relax(p, r); }
    for (const route of this.routes.values()) route.setSpeed(Infinity);
    const back = [...this.yieldedBy.keys()];
    this.yieldedBy.clear();
    await this.policy('-B', back);
    for (const r of this.rt.values()) { r.front = false; r.focusLive = false; }
    this.emit();
  }

  fresh(app) {
    return {
      pid: app?.pid || 0, pids: new Set(), hot: new Set(), cpu: 0, mem: 0, down: 0, up: 0, f: 1, fNet: 1,
      bg: new Set(), front: false, wasFront: false, over: false, overAt: 0, warnedAt: 0, routed: false,
      tap: null, focusLive: false, focusHid: [], focusHidDone: false, musicPaused: [],
      awake: null, overdrive: false, overdriveWait: false, reniced: [], trail: [],
    };
  }
  runtime(id) { if (!this.rt.has(id)) this.rt.set(id, this.fresh(null)); return this.rt.get(id); }

  // ---------- the look, once a second ----------
  async tick() {
    if (this.ticking || this.suspended) return;
    if (!this.plugins.size) { this.sleep(); this.emit(); return; }
    this.ticking = true;
    try { await this.look(); } catch (err) { console.warn('Plugin look failed:', err.message); }
    this.ticking = false;
  }
  async look() {
    const now = Date.now();
    // Network is read every few seconds while any plugged-in app is open (more often while a rule needs it or
    // its menu is open), so its numbers and its normal are always real.
    const needNet = [...this.plugins.values()].map(eff).some((p) => p.on && (p.net !== FREE || p.cpu >= 11)) || this.watching.size > 0;
    const anyOpen = [...this.rt.values()].some((r) => r.pid);
    const netEvery = needNet ? 1800 : anyOpen ? 3500 : Infinity;
    const [appsRes, ps] = await Promise.all([
      this.eyes.ask('a'),
      run('ps', ['-Axo', 'pid=,ppid=,uid=,time=,rss=,comm=']),
      now - this.net.at > netEvery ? this.sampleNet(now) : null,
    ]);
    if (appsRes?.a) this.apps = appsRes.a;
    this.front = this.apps.find((a) => a.active) || null;
    const procs = parsePs(ps.out);
    // Compared with the last look's numbers (kept aside before this look's replace them).
    const last = this.prev;
    const dt = last ? (now - last.at) / 1000 : 0;
    const coreOf = (p) => {
      if (!dt) return 0;
      const before = last.times.get(p.pid);
      return before == null || p.time < before ? 0 : Math.max(0, ((p.time - before) / dt) * 100);
    };
    this.prev = { at: now, times: new Map([...procs.values()].map((p) => [p.pid, p.time])) };

    // Which app each process belongs to: inside its .app, or started by it.
    const byPid = new Map(this.apps.map((a) => [a.pid, a]));
    const roots = this.apps.filter((a) => a.path).sort((a, b) => b.path.length - a.path.length);
    const groups = new Map(this.apps.map((a) => [a.pid, { app: a, pids: [], cpu: 0, rss: 0, net: 0, hot: [] }]));
    this.procs = procs;
    this.pidCore = new Map();
    for (const p of procs.values()) {
      if (p.uid !== MY_UID) continue;
      let a = byPid.get(p.pid) || roots.find((r) => p.exe.startsWith(`${r.path}/`));
      for (let q = p, i = 0; !a && q && q.ppid > 1 && i < 8; i++) { a = byPid.get(q.ppid); q = procs.get(q.ppid); }
      if (!a) continue;
      const g = groups.get(a.pid);
      const c = coreOf(p), n = this.net.rates.get(p.pid) || 0;
      this.pidCore.set(p.pid, c);
      g.pids.push(p.pid); g.cpu += c; g.rss += p.rss; g.net += n;
      if ((c >= 3 || n > 4096) && !PROTECTED.test(p.exe) && p.pid !== this.d.selfPid) g.hot.push(p.pid);
    }
    this.groups = groups;

    const wantFoot = [...this.plugins.values()].map(eff).some((p) => p.on && p.ram !== FREE) || this.watching.size > 0;
    const feet = wantFoot && this.d.footprints ? await this.d.footprints().catch(() => null) : null;

    for (const p0 of this.plugins.values()) {
      const p = eff(p0);
      const app = this.match(p);
      const r = this.runtime(p.id);
      if (!app) { if (r.pid) await this.appGone(p, r); continue; }
      if (r.pid !== app.pid) {
        await this.appGone(p, r);
        Object.assign(r, this.fresh(app));
        this.checkRouted(p, r).then(() => this.syncRoute(p));
      }
      if (!p0.path && app.path) p0.path = app.path;
      const g = groups.get(app.pid) || { pids: [app.pid], cpu: 0, rss: 0, net: 0, hot: [] };
      // Parts macOS needs (Finder, the Dock…) are never paused or quieted, even when they're the plugged app.
      r.pids = new Set(g.pids.filter((pid) => pid !== this.d.selfPid && !PROTECTED.test(procs.get(pid)?.exe || '')));
      r.allPids = new Set(g.pids.filter((pid) => pid !== this.d.selfPid));
      r.hot = new Set(g.hot);
      r.cpu = Math.min(100, g.cpu / this.cores);
      r.mem = feet ? g.pids.reduce((s, pid) => s + (feet.get(pid) ?? procs.get(pid)?.rss ?? 0), 0) : g.rss;
      // Memory is read two ways (each part's real footprint, or a rougher count that runs high); when the way
      // changes, its normal starts over, so the two never mix.
      const src = feet ? 'foot' : 'rss';
      if (r.memSrc !== src) { r.memSrc = src; if (r.avg) r.avg.mem = r.mem; }
      const route = this.routes.get(p.id);
      if (route && r.routed) {
        const b = route.bytes, last = r.routeBytes;
        const secs = last ? (now - last.at) / 1000 : 0;
        r.down = secs ? Math.max(0, (b.down - last.down) / secs) : 0; r.up = secs ? Math.max(0, (b.up - last.up) / secs) : 0;
        r.routeBytes = { at: now, down: b.down, up: b.up };
      } else {
        r.down = g.pids.reduce((s, pid) => s + (this.net.down.get(pid) || 0), 0);
        r.up = g.pids.reduce((s, pid) => s + (this.net.up.get(pid) || 0), 0);
      }
      // Its normal use: a running average over about five minutes (each look counts for 1/300), from launch.
      const netNow = r.down + r.up, k = 1 / 300;
      if (!r.avg) r.avg = { cpu: r.cpu, mem: r.mem, net: netNow, n: 0 };
      else Object.assign(r.avg, { cpu: r.avg.cpu + (r.cpu - r.avg.cpu) * Math.max(k, 1 / (r.avg.n + 2)), mem: r.avg.mem + (r.mem - r.avg.mem) * Math.max(k, 1 / (r.avg.n + 2)), net: r.avg.net + (netNow - r.avg.net) * Math.max(k, 1 / (r.avg.n + 2)) });
      r.avg.n++;
      r.wasFront = r.front;
      r.front = this.front?.pid === app.pid;
      r.trail.push(Math.round(r.cpu * 10) / 10); if (r.trail.length > 30) r.trail.shift();
      if (!p.on) { await this.relax(p, r); continue; }
      this.limitCpu(p, r);
      this.limitNet(p, r);
      await this.quietSelf(p, r);
      await this.memory(p, r);
      await this.sound(p0, r);
      await this.focus(p, r);
      r.overdrive = p.cpu === 12 || p.ram === 12;
      if (p.cpu === 12 && r.awakeOD == null) r.awakeOD = this.d.power?.start('prevent-app-suspension') ?? null;
      if (p.cpu !== 12 && r.awakeOD != null) { try { this.d.power?.stop(r.awakeOD); } catch {} r.awakeOD = null; }
    }
    await this.yields();
    this.ensureDuty();
    this.saveSafetySoon();
    this.emit();
  }
  async sampleNet(now) {
    if (this.net.busy) return;
    this.net.busy = true;
    const r = await run('nettop', ['-P', '-L', '1', '-x', '-J', 'bytes_in,bytes_out'], 5000);
    this.net.busy = false;
    const cur = parseNettop(r.out);
    const prev = this.net.prev, secs = prev ? (now - this.net.at) / 1000 : 0;
    const down = new Map(), up = new Map(), rates = new Map();
    if (prev && secs > 0.5) {
      for (const [pid, [i, o]] of cur) {
        const was = prev.get(pid);
        if (!was) continue;
        const di = Math.max(0, i - was[0]) / secs, du = Math.max(0, o - was[1]) / secs;
        down.set(pid, di); up.set(pid, du); rates.set(pid, di + du);
      }
    }
    Object.assign(this.net, { at: now, prev: cur, down, up, rates });
  }
  match(p) {
    return this.apps.find((a) => (p.bundle ? a.bundle === p.bundle : a.name === p.name)) || null;
  }

  // ---------- processor ----------
  // A limit holds the app to that many tenths of the whole Mac. Pane measures what it used, and when it's
  // over, pauses its busy parts in short bursts: run fraction f of each 100 ms, paused the rest. f follows
  // the app: down when it's over, back up a little at a time when it's under.
  limitCpu(p, r) {
    if (p.cpu >= FREE) { r.f = 1; return; }
    const T = p.cpu * 10, U = r.cpu;
    if (U > T * 1.05 && U > 0.5) r.f = clamp(0.5 * r.f + 0.5 * ((r.f * T) / U), 0.1, 1);
    else if (U < T * 0.75) r.f = Math.min(1, r.f + 0.08);
  }
  // Without its own network (where the proxy holds it to the speed exactly), a network limit works the same
  // way: over the speed, its busy parts get paused in bursts.
  limitNet(p, r) {
    const route = this.routes.get(p.id);
    if (route) route.setSpeed(p.net < FREE ? NET_SPEEDS[p.net] : Infinity);
    if (p.net >= FREE || (route && r.routed)) { r.fNet = 1; return; }
    const T = NET_SPEEDS[p.net], U = r.down + r.up;
    if (U > T * 1.1) r.fNet = clamp(0.5 * r.fNet + 0.5 * ((r.fNet * T) / U), 0.1, 1);
    else if (U < T * 0.7) r.fNet = Math.min(1, r.fNet + 0.08);
  }
  ensureDuty() {
    const any = [...this.plugins.values()].some((p) => { const r = this.rt.get(p.id); return p.on && r?.pid && Math.min(r.f, r.fNet) < 0.97; });
    if (any && !this.duty) this.duty = setInterval(() => this.burst(), 100);
    if (!any && this.duty) { clearInterval(this.duty); this.duty = null; this.contAll(); }
  }
  burst() {
    for (const p of this.plugins.values()) {
      const r = this.rt.get(p.id);
      if (!p.on || !r?.pid) continue;
      const f = Math.min(r.f, r.fNet);
      if (f >= 0.97) continue;
      const pids = [...(r.hot.size ? r.hot : r.pids)].filter((pid) => pid !== this.d.selfPid);
      const off = clamp(Math.round((1 - f) * 100), 5, 90);
      for (const pid of pids) { try { process.kill(pid, 'SIGSTOP'); this.stopped.add(pid); } catch {} }
      setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 'SIGCONT'); } catch {} this.stopped.delete(pid); } }, off);
    }
  }
  contAll() { for (const pid of this.stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} } this.stopped.clear(); }

  // Low limits also put the app in the background: macOS then runs it on the efficiency cores and lets its
  // disk and network wait for everyone else. Gentler than pausing, and often enough on its own.
  async quietSelf(p, r) {
    const want = p.cpu <= 4 || p.net <= 4;
    if (want) {
      const add = [...r.pids].filter((pid) => !r.bg.has(pid));
      for (const pid of add) r.bg.add(pid);
      await this.policy('-b', add);
    } else if (r.bg.size) {
      const back = [...r.bg].filter((pid) => !this.yieldedBy.has(pid));
      r.bg.clear();
      await this.policy('-B', back);
    }
    if (p.cpu >= 11) await this.policy('-B', [...r.pids].filter((pid) => !r.cleared?.has(pid))).then(() => { r.cleared = new Set(r.pids); });
  }
  async policy(flag, pids) {
    const list = pids.filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== this.d.selfPid);
    for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map((pid) => run('taskpolicy', [flag, '-p', String(pid)], 2000)));
  }

  // A boost makes room: other apps' parts that are busy right now go into the background while the boosted
  // app runs (processor: busy with the processor; network: moving data). Focus, while the app is in front,
  // quiets every other app. Each part remembers why it was quieted, and is put back once no reason is left.
  async yields() {
    const reasons = new Map(); // reason -> Set(pid) that should be quieted for it
    const own = new Set();
    const all = [...this.plugins.values()].map(eff);
    for (const p of all) {
      const r = this.rt.get(p.id);
      if (!p.on || !r?.pid) continue;
      if (p.cpu >= 11 || p.net >= 11 || (p.focus.on && p.focus.quiet && r.front)) own.add(r.pid);
    }
    for (const p of all) {
      const r = this.rt.get(p.id);
      if (!p.on || !r?.pid) continue;
      const others = [...(this.groups || new Map()).values()].filter((g) => !own.has(g.app.pid) && g.app.pid !== r.pid);
      const add = (reason, pick) => {
        const set = reasons.get(reason) || new Set();
        for (const g of others) for (const pid of pick(g)) set.add(pid);
        // A reason keeps the parts it already quieted, so they don't flicker in and out of the background.
        for (const [pid, why] of this.yieldedBy) if (why.has(reason) && alive(pid)) set.add(pid);
        reasons.set(reason, set);
      };
      // Overdrive: every other app steps back while it runs, busy or not. Boost: only the busy ones.
      if (p.cpu === 12) add(`cpu:${p.id}`, (g) => g.pids);
      else if (p.cpu === 11) add(`cpu:${p.id}`, (g) => g.pids.filter((pid) => (this.prevCore(pid) || 0) >= 20));
      if (p.net >= 11) add(`net:${p.id}`, (g) => g.pids.filter((pid) => (this.net.rates.get(pid) || 0) > 100 * 1024));
      if (p.focus.on && p.focus.quiet && r.front) add(`focus:${p.id}`, (g) => g.pids);
    }
    const quiet = [], wake = [];
    for (const [reason, set] of reasons) for (const pid of set) {
      if (PROTECTED.test(this.exeOf(pid))) continue;
      const why = this.yieldedBy.get(pid) || new Set();
      if (!why.size) quiet.push(pid);
      why.add(reason);
      this.yieldedBy.set(pid, why);
    }
    for (const [pid, why] of this.yieldedBy) {
      for (const reason of [...why]) if (!reasons.get(reason)?.has(pid)) why.delete(reason);
      if (!why.size) {
        this.yieldedBy.delete(pid);
        if (![...this.rt.values()].some((r) => r.bg.has(pid))) wake.push(pid);
      }
    }
    await this.policy('-b', [...new Set(quiet)]);
    await this.policy('-B', wake);
  }
  prevCore(pid) { return this.pidCore?.get(pid) || 0; }
  exeOf(pid) { return this.procs?.get(pid)?.exe || ''; }

  // ---------- memory ----------
  // A limit is a line, not a cage: macOS has no way to cap an app's memory. Past it, Pane tells you, and
  // (if you chose "hide it") hides the app once you've left it, so macOS naps it and compresses what it holds.
  // A boost hides the other big apps each time you come to this one, so it has more room.
  async memory(p, r) {
    const now = Date.now();
    if (p.ram < FREE) {
      const cap = (p.ram / 10) * this.memTotal;
      if (r.mem > cap && !r.over) {
        r.over = true; r.overAt = now;
        if (now - r.warnedAt > 15 * 60000) { r.warnedAt = now; this.d.notify?.(`${p.name} is over its memory share`, `It’s using ${gb(r.mem)} of the ${gb(cap)} you gave it.${p.ramAct === 'hide' ? ' Pane will hide it when you leave it, so macOS can squeeze it.' : ''}`); }
      } else if (r.mem < cap * 0.95) r.over = false;
      if (r.over && p.ramAct === 'hide' && !r.front && !r.hidOver) { r.hidOver = true; await this.eyes.ask(`hide ${r.pid}`); }
      if (!r.over) r.hidOver = false;
    } else r.over = false;
    if (p.ram >= 11 && r.front && !r.wasFront) {
      const line = p.ram === 12 ? 0.5 * 1073741824 : 1.5 * 1073741824; // overdrive makes room from smaller apps too
      const big = [...this.groups.values()].filter((g) => g.app.pid !== r.pid && !g.app.active && !g.app.hidden && g.rss > line && g.app.bundle !== 'com.apple.finder');
      if (big.length) await this.eyes.ask(`hide ${big.map((g) => g.app.pid).join(' ')}`);
    }
  }

  // ---------- sound ----------
  // Each app gets a volume of its own: Pane's helper taps the app's sound (Core Audio process taps), mutes what
  // it was sending to your speakers and plays it back at the share's gain. 1–10 cells are 10–100%, boost 150%,
  // overdrive 200%. Your Mac's own volume is never touched. Off: no tap, the app sounds exactly as it did.
  // The tap belongs to the helper, so if it (or Pane) stops, macOS removes it and the app's sound is back.
  async sound(p0, r) {
    const L = p0.out;
    const want = p0.on && r.pid && L > 0;
    if (!want) { this.stopTap(r); return; }
    const gain = L <= FREE ? L / 10 : L === 11 ? 1.5 : 2;
    if (!r.tap) {
      const path = this.d.helperPath?.();
      if (!path) return;
      let child;
      try { child = require('child_process').spawn(path, ['tap'], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return; }
      const t = { child, pids: '', gain: null, peak: 0, tapped: 0, error: null, buf: '' };
      child.stdout.on('data', (d) => {
        t.buf += d;
        let k;
        while ((k = t.buf.indexOf('\n')) >= 0) {
          const line = t.buf.slice(0, k); t.buf = t.buf.slice(k + 1);
          try { const m = JSON.parse(line); t.peak = Number(m.peak) || 0; t.tapped = m.tapped || 0; t.error = m.error || null; } catch {}
        }
      });
      child.on('exit', () => { if (r.tap === t) r.tap = null; });
      child.on('error', () => { if (r.tap === t) r.tap = null; });
      child.stdin.on('error', () => {});
      r.tap = t;
    }
    const t = r.tap;
    const pids = [...r.allPids || r.pids].sort((a, b) => a - b).join(' ');
    if (pids !== t.pids) { t.pids = pids; t.child.stdin.write(`pids ${pids}\n`); }
    if (gain !== t.gain) { t.gain = gain; t.child.stdin.write(`gain ${gain}\n`); }
  }
  stopTap(r) {
    const t = r.tap;
    r.tap = null;
    if (t) { try { t.child.stdin.end(); } catch {} setTimeout(() => { try { t.child.kill(); } catch {} }, 1500); }
  }

  // ---------- Focus mode ----------
  // While the app is in front: other apps quieted into the background (see yields; they stay open and
  // visible), other screens blurred (main.js draws it), your Mac kept awake, and music paused if you asked.
  // Leave the app and it all eases off; come back and it starts again.
  async focus(p, r) {
    const active = p.focus.on && r.front;
    if (active && !r.focusLive) {
      r.focusLive = true;
      if (p.focus.music && !r.musicDone) {
        r.musicDone = true;
        for (const b of PLAYERS) {
          if (b === p.bundle || !this.apps.some((x) => x.bundle === b)) continue;
          const s = await osa(`tell application id "${b}"\nif player state is playing then\npause\nreturn "yes"\nend if\nend tell\nreturn "no"`);
          if (s.out.trim() === 'yes') r.musicPaused.push(b);
        }
      }
    }
    if (active && p.focus.awake && !r.awake) r.awake = this.d.power?.start('prevent-display-sleep') ?? null;
    if ((!active || !p.focus.awake) && r.awake != null) { try { this.d.power?.stop(r.awake); } catch {} r.awake = null; }
    if (!active) r.focusLive = false;
    if (!p.focus.on && (r.focusHidDone || r.musicDone)) await this.endFocus(r);
  }
  async endFocus(r) {
    if (r.focusHid.length) await this.eyes.ask(`unhide ${r.focusHid.join(' ')}`);
    for (const b of r.musicPaused) await osa(`tell application id "${b}" to play`);
    r.focusHid = []; r.musicPaused = []; r.focusHidDone = false; r.musicDone = false; r.focusLive = false;
    if (r.awake != null) { try { this.d.power?.stop(r.awake); } catch {} r.awake = null; }
  }

  // ---------- own network ----------
  // The proxy runs while the plugin has a network picked, and also while its app is still using it (you
  // picked "Usual", or turned the plugin off, but the app hasn't reopened yet): closing it then would cut
  // the app off. With no network picked it just passes connections through on your usual one.
  syncRoute(p) {
    const keep = p.route.port && (p.route.device || this.rt.get(p.id)?.routed);
    const have = this.routes.get(p.id);
    if (have && (!keep || have.port !== p.route.port)) { have.close(); this.routes.delete(p.id); }
    if (keep && !this.routes.get(p.id)) this.routes.set(p.id, new Route({ port: p.route.port, device: p.route.device, fallback: p.route.fallback }));
    const route = this.routes.get(p.id);
    if (route) { route.device = p.route.device; route.fallback = p.route.device ? p.route.fallback : true; }
  }
  async checkRouted(p, r) {
    if (!p.route.port || !r.pid) { r.routed = false; return; }
    const res = await run('ps', ['-o', 'args=', '-p', String(r.pid)]);
    r.routed = res.out.includes(`--proxy-server=socks5://127.0.0.1:${p.route.port}`);
  }
  // Quit the app and open it again, on its own network (or back on your usual one).
  async reopen(id, routed) {
    const p = this.plugins.get(id), r = this.rt.get(id);
    if (!p?.bundle) return { ok: false, message: 'Pane can’t reopen this app.' };
    if (r?.pid) {
      await osa(`tell application id "${p.bundle}" to quit`, 15000);
      const t0 = Date.now();
      while (alive(r.pid) && Date.now() - t0 < 12000) await new Promise((res) => setTimeout(res, 250));
      if (alive(r.pid)) return { ok: false, message: `${p.name} didn’t quit. It may be waiting for you to save something.` };
    }
    const args = routed && p.route.port ? ['-b', p.bundle, '--args', `--proxy-server=socks5://127.0.0.1:${p.route.port}`] : ['-b', p.bundle];
    const res = await run('open', args, 15000);
    if (!res.ok) return { ok: false, message: `Couldn’t open ${p.name}.` };
    return { ok: true, message: routed ? `${p.name} is open on ${p.route.name || 'its own network'}.` : `${p.name} is back on your usual network.` };
  }

  // ---------- putting things back ----------
  // Turned off (or its app quit): everything this plugin changed goes back the way it was.
  async relax(p, r) {
    r.f = 1; r.fNet = 1;
    this.routes.get(p.id)?.setSpeed(Infinity);
    if (r.bg.size) { const back = [...r.bg]; r.bg.clear(); await this.policy('-B', back.filter((pid) => !this.yieldedBy.has(pid))); }
    this.stopTap(r);
    if (r.focusHidDone || r.musicDone || r.awake != null) await this.endFocus(r);
    if (r.awakeOD != null) { try { this.d.power?.stop(r.awakeOD); } catch {} r.awakeOD = null; }
    r.overdrive = false;
  }
  async appGone(p, r) {
    this.stopTap(r);
    if (r.focusHid.length) await this.eyes.ask(`unhide ${r.focusHid.join(' ')}`);
    if (r.awake != null) { try { this.d.power?.stop(r.awake); } catch {} }
    if (r.awakeOD != null) { try { this.d.power?.stop(r.awakeOD); } catch {} }
    Object.assign(r, this.fresh(null));
    this.syncRoute(p); // a route kept only for an app that was still using it can close now
  }
  // Pane is quitting: nothing stays paused or quieted, the levels go back, and the routes close.
  releaseAll() {
    if (this.duty) { clearInterval(this.duty); this.duty = null; }
    this.contAll();
    this.sleep();
    const back = new Set([...this.yieldedBy.keys()]);
    for (const r of this.rt.values()) for (const pid of r.bg) back.add(pid);
    for (const pid of back) execFile('taskpolicy', ['-B', '-p', String(pid)], () => {});
    for (const r of this.rt.values()) {
      this.stopTap(r);
      if (r.awake != null) { try { this.d.power?.stop(r.awake); } catch {} }
      if (r.awakeOD != null) { try { this.d.power?.stop(r.awakeOD); } catch {} }
    }
    for (const route of this.routes.values()) route.close();
    this.eyes.stop();
    this.d.safety.set({ cont: [], unbg: [] });
  }
  saveSafetySoon() {
    if (this.safetyTimer) return;
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      const cont = new Set(), unbg = new Set(this.yieldedBy.keys());
      for (const [id, r] of this.rt) {
        const p = this.plugins.get(id);
        if (p?.on && Math.min(r.f, r.fNet) < 0.97) for (const pid of r.hot.size ? r.hot : r.pids) cont.add(pid);
        for (const pid of r.bg) unbg.add(pid);
      }
      this.d.safety.set({ cont: [...cont], unbg: [...unbg] });
    }, 2000);
  }

  // ---------- what the badges, the menu, Debug and the settings page see ----------
  // What the pod says (Active or Inactive), with the specifics in `detail` for the menu and Debug.
  status(p0, r) {
    const s = this.detail(p0, r);
    return { ...s, detail: s.text, text: p0.on ? 'Active' : 'Inactive' };
  }
  detail(p0, r) {
    const p = eff(p0);
    if (!p.on) return { tone: 'off', text: 'Turned off' };
    if (!r.pid) return { tone: 'idle', text: 'Not open' };
    const f = Math.min(r.f, r.fNet);
    if (!p.seen) return { tone: 'new', text: 'Click to set up' };
    if (r.overdrive) return { tone: 'hot', text: 'Overdrive' };
    if (r.focusLive) return { tone: 'focus', text: 'Focus' };
    if (f < 0.9) return { tone: 'warn', text: `Slowed ${Math.round((1 - f) * 100)}%` };
    if (r.over) return { tone: 'warn', text: 'Over its memory' };
    if (p.route.device && !r.routed) return { tone: 'warn', text: 'Needs a reopen' };
    if (p.route.device && r.routed && !this.routes.get(p.id)?.ip) return { tone: p.route.fallback ? 'warn' : 'bad', text: `${p.route.name || 'Its network'} is off` };
    if (p.route.device && r.routed) return { tone: 'ok', text: `On ${p.route.name}` };
    if (ASPECTS.some((a) => p[a] >= 11)) return { tone: 'boost', text: 'Boosted' };
    if (ASPECTS.some((a) => p[a] < FREE)) return { tone: 'ok', text: 'Limited' };
    return { tone: 'ok', text: 'Nothing set yet' };
  }
  view(p) {
    const r = this.runtime(p.id);
    const app = this.match(p);
    const route = this.routes.get(p.id);
    return {
      id: p.id, name: p.name, bundle: p.bundle, path: p.path, on: p.on, seen: p.seen,
      levels: Object.fromEntries(ASPECTS.map((a) => [a, p[a]])), ramAct: p.ramAct, route: { ...p.route, up: !!route?.ip, error: route?.error || null }, focus: { ...p.focus },
      running: !!r.pid, pid: r.pid, front: r.front, guarded: /\/(Finder|Dock|SystemUIServer|ControlCenter|NotificationCenter)\.app$/.test(p.path || ''), chromium: isChromium(app || p), player: PLAYERS.includes(p.bundle),
      live: { cpu: r.cpu, mem: r.mem, down: r.down, up: r.up, trail: [...r.trail], sound: r.tap ? { peak: r.tap.peak, playing: r.tap.tapped > 0, error: r.tap.error } : null },
      normal: r.avg && r.avg.n >= 5 ? { cpu: r.avg.cpu, mem: r.avg.mem, net: r.avg.net } : null,
      throttle: Math.max(0, 1 - Math.min(r.f, r.fNet)), over: r.over, routed: r.routed, focusLive: r.focusLive,
      overdrive: r.overdrive, quieted: this.quietedFor(p.id), focusOn: !!r.focusLive && p.focus.blur,
      status: this.status(p, r),
    };
  }
  quietedFor(id) {
    let n = 0;
    for (const why of this.yieldedBy.values()) if ([...why].some((x) => x.endsWith(`:${id}`))) n++;
    return n;
  }
  list() { return [...this.plugins.values()].map((p) => this.view(p)); }
  caps() { return { cores: this.cores, mem: this.memTotal, netSpeeds: NET_SPEEDS, max: MAX, free: FREE }; }
  emit() { this.lastList = this.list(); this.d.onChange?.(this.lastList); }
  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.d.store.set([...this.plugins.values()]), 300);
  }

  // ---------- changes from the picker, the menu and the settings page ----------
  has(app) { return [...this.plugins.values()].find((p) => (app.bundle ? p.bundle === app.bundle : p.name === app.name)) || null; }
  add(app) {
    const had = this.has(app);
    if (had) return had;
    const p = clean({ id: app.bundle || `name:${app.name}`, bundle: app.bundle || null, name: app.name, path: app.path || null });
    this.plugins.set(p.id, p);
    this.saveSoon();
    this.wake();
    this.emit();
    return p;
  }
  async update(id, patch) {
    const p = this.plugins.get(id);
    if (!p) return { ok: false, message: 'That plugin is gone.' };
    const before = { ...p };
    const next = clean({ ...p, ...patch, route: { ...p.route, ...(patch.route || {}) }, focus: { ...p.focus, ...(patch.focus || {}) } });
    // A new route gets a port of its own, kept for good, so the app's --proxy-server stays right.
    if (next.route.device && !next.route.port) next.route.port = await freePort();
    if (next.route.device) {
      const n = (await networks()).find((x) => x.device === next.route.device);
      if (n) next.route.name = n.name;
    }
    this.plugins.set(id, next);
    const r = this.runtime(id);
    let message = null;
    if (!next.on && before.on) await this.relax(next, r);
    if (before.focus.on && !next.focus.on) await this.endFocus(r);
    if (next.route.device !== before.route.device || next.route.port !== before.route.port) { this.syncRoute(next); await this.checkRouted(next, r); }
    else this.syncRoute(next);
    this.saveSoon();
    this.tick();
    this.emit();
    return { ok: !message, message, plugin: this.view(next) };
  }
  async remove(id) {
    const p = this.plugins.get(id);
    if (!p) return { ok: true };
    const r = this.runtime(id);
    p.on = false;
    await this.relax(p, r);
    await this.yields(); // drops the reasons this plugin had for quieting other apps
    const route = this.routes.get(id);
    if (route) { route.close(); this.routes.delete(id); }
    this.plugins.delete(id);
    this.rt.delete(id);
    this.saveSoon();
    this.emit();
    return { ok: true, routed: r.routed };
  }
  watch(id, on) { if (on) this.watching.add(id); else this.watching.delete(id); if (on) this.wake(); }
}
const gb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);

module.exports = { Engine, Eyes, networks, ASPECTS, MAX, FREE, NET_SPEEDS, isChromium, _test: { clean, parsePs, parseNettop } };
