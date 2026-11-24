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
// Running apps, from lsappinfo: the ones with a Dock icon ("Foreground"), plus menu bar apps you installed
// ("UIElement" ones living in their own .app, not macOS's own and not a helper tucked inside another app).
function parseApps(text) {
  const apps = [];
  for (const block of text.split(/\n\s*\d+\) /)) {
    const name = /^"([^"]*)"/.exec(block.trim())?.[1];
    const pid = Number(/pid = (\d+)/.exec(block)?.[1]);
    const type = /type="([^"]+)"/.exec(block)?.[1];
    const bundle = /bundleID="([^"]+)"/.exec(block)?.[1] || null;
    const where = /bundle path="([^"]+)"/.exec(block)?.[1] || null;
    if (!name || !pid) continue;
    const menubar = type === 'UIElement' && where && /\.app$/.test(where) && !/\.app\//.test(where) &&
      !where.startsWith('/System/') && !/^com\.apple\./.test(bundle || '') && !/\b(Helper|Agent|Daemon|Service)\b/i.test(name);
    if (type !== 'Foreground' && !menubar) continue;
    apps.push({ name, pid, bundle, path: where, kind: menubar ? 'menubar' : 'app' });
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

// Everything that isn't an app, sorted into a few plain categories. Checked in order; the first match wins.
// `passes`: it finishes on its own, so waiting is the fix. `byPath`: matched on where the program lives.
const CATEGORIES = [
  { id: 'kernel', label: 'macOS core', about: 'runs the heart of macOS. When your Mac is hot it also slows things down on purpose to cool off', match: /^kernel_task$/ },
  { id: 'helpers', label: 'Helpers from your apps', about: 'are background parts of apps you installed (updaters, sync, login items)', byPath: (exe) => !exe.startsWith('/System/') && /\/([^/]+)\.app\//.exec(exe)?.[1] },
  { id: 'screen', label: 'Screen & windows', about: 'draws every window and animation on your screens', match: /^(WindowServer|Dock|WindowManager|NotificationCenter|ControlCenter|SystemUIServer|Wallpaper.*|loginwindow|universalaccessd)$/ },
  { id: 'search', label: 'Spotlight', about: 'is indexing your files for search', passes: true, match: /^(mds|mds_stores|mdworker|mdworker_shared|mdbulkimport|mdsync|corespotlightd|Spotlight|spotlightknowledged)$/ },
  { id: 'sync', label: 'iCloud & sync', about: 'is syncing your files and data', passes: true, match: /^(bird|cloudd|fileproviderd|FileProvider.*|cloudphotod|CloudKeychainProxy|syncdefaultsd|itunescloudd|protectedcloudkeysyncing)$/ },
  { id: 'photos', label: 'Photo & video analysis', about: 'is scanning your photos and videos for faces, places and text', passes: true, match: /^(photoanalysisd|mediaanalysisd|photolibraryd|mediaanalysisd-access|VisualIntelligence.*)$/ },
  { id: 'backup', label: 'Time Machine', about: 'is backing up', passes: true, match: /^(backupd|backupd-helper)$/ },
  { id: 'update', label: 'Software updates', about: 'is downloading or installing updates', passes: true, match: /^(softwareupdated|SoftwareUpdateNotificationManager|installd|system_installd|storedownloadd|appstoreagent|mobileassetd|UpdateBrainService|com\.apple\.MobileSoftwareUpdate.*)$/ },
  { id: 'security', label: 'Security checks', about: 'is checking apps and files for malware', passes: true, match: /^(syspolicyd|XprotectService|XProtect.*|MRT|trustd|amfid|endpointsecurityd)$/ },
  { id: 'ai', label: 'Siri & Apple Intelligence', about: 'is learning from your Mac and running on-device models', passes: true, match: /^(siriactionsd|siriknowledged|assistantd|intelligenceplatformd|generativeexperiencesd|modelmanagerd|knowledgeconstructiond|duetexpertd|TGOnDeviceInference.*)$/ },
  { id: 'sound', label: 'Sound & video', about: 'plays sound and decodes video for every app', match: /^(coreaudiod|audiomxd|AudioComponentRegistrar|VTDecoderXPCService|VTEncoderXPCService)$/ },
  { id: 'network', label: 'Network & downloads', about: 'handles downloads, Wi-Fi and Bluetooth', match: /^(nsurlsessiond|mDNSResponder|networkd|configd|apsd|symptomsd|airportd|WiFiAgent|bluetoothd|rapportd|sharingd)$/ },
  { id: 'dev', label: 'Developer & command-line tools', about: 'are programs started from a terminal or a code editor', match: /^(node|python[\d.]*|Python|ruby|java|php|perl|go|cargo|rustc|clang|swift.*|xcodebuild|XCBBuildService|SourceKitService|make|cmake|ninja|git|deno|bun|ollama|docker.*|com\.docker\..*|qemu.*|gradle.*)$/, byPath: (exe) => /^\/(opt\/homebrew|usr\/local)\//.test(exe) && path.basename(exe) },
  { id: 'other', label: 'Other macOS tasks', about: 'are small background parts of macOS' },
];
const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
// Which category a process falls in, and the name to show for it inside that category.
function categorize(exe) {
  const name = path.basename(exe);
  for (const c of CATEGORIES) {
    const hit = c.byPath?.(exe);
    if (hit) return { cat: c, name: hit };
    if (c.match?.test(name)) return { cat: c, name };
  }
  return { cat: CAT_BY_ID.other, name };
}

// ---------- the sampler ----------
const S = {
  prev: null, // { at, times: Map(pid -> cpu seconds), cpus }
  history: [], // whole-Mac CPU, 0-100
  appHistory: new Map(), // app key -> [cpu share, 0-100]
  slow: { at: 0, data: null }, // battery, disk, heat, sleep blockers: every 10 s
  icons: new Map(), // bundle path -> data URL (or null while it loads)
  io: null, // the last network, disk and graphics totals, for turning into speeds
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

// ---------- memory per process, the way Activity Monitor counts it ----------
// ps's RSS counts memory shared between processes once in every one of them, so an app made of 20 helpers
// looked several times bigger than it is. top's MEM is each process's own footprint, the number Activity
// Monitor shows. top costs most of a second of processor time, so it runs every 8 seconds at most, in the
// background, and the looks in between use its last answer.
const FOOT_MS = 8000;
const foot = { at: 0, map: null, pending: null };
const UNIT = { B: 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
function parseTop(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMGT])\b/.exec(line);
    if (m) map.set(Number(m[1]), Math.round(Number(m[2]) * UNIT[m[3]]));
  }
  return map;
}
function refreshFootprints() {
  if (!foot.pending) {
    foot.pending = run('top', ['-l', '1', '-stats', 'pid,mem'], 6000).then((out) => {
      const map = parseTop(out);
      if (map.size > 10) { foot.map = map; foot.at = Date.now(); }
      foot.pending = null;
    });
  }
  return foot.pending;
}
async function footprints() {
  if (!foot.map) await refreshFootprints(); // the very first look waits for it, so numbers never jump
  else if (Date.now() - foot.at > FOOT_MS) refreshFootprints();
  return foot.map || new Map();
}
// Started the moment Debug is asked to open, so it's ready by the time the panel has loaded.
function warm() { if (!foot.map) refreshFootprints(); }

// ---------- graphics, network and disk: running totals, turned into speeds ----------
// Each is read twice over: once for the whole Mac (netstat, the storage driver, the GPU's own busy %), and
// once per process, so an app's view shows only that app's traffic, reads and writes and GPU time:
//   network  nettop: bytes in and out so far, per process (no permission needed)
//   disk     Pane's helper (proc_pid_rusage): bytes read and written so far, per process you own
//   graphics ioreg: each GPU client's accumulated GPU time, in nanoseconds, with the pid that opened it
let helperFor = null; // set by main.js: () => path of native/pane-files
function parseNettop(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /\.(\d+),(\d+),(\d+),?\s*$/.exec(line); // "Google Chrome H.47397,87493306,318858,"
    if (!m) continue;
    const pid = Number(m[1]);
    const was = map.get(pid) || [0, 0];
    map.set(pid, [was[0] + Number(m[2]), was[1] + Number(m[3])]);
  }
  return map;
}
function parseIo(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), [Number(m[2]), Number(m[3])]);
  }
  return map;
}
// One AGXDeviceUserClient (or similar) block per GPU client: its "AppUsage" holds accumulatedGPUTime for
// each queue, and "IOUserClientCreator" names the pid. Summed per pid.
function parseGpuClients(text) {
  const map = new Map();
  for (const block of text.split(/\+-o /)) {
    const pid = Number(/"IOUserClientCreator" = "pid (\d+)/.exec(block)?.[1]);
    if (!pid) continue;
    const ns = [...block.matchAll(/"accumulatedGPUTime"=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    map.set(pid, (map.get(pid) || 0) + ns);
  }
  return map;
}
async function counters() {
  const helper = helperFor?.();
  const [net, disk, gpu, nettop, io] = await Promise.all([
    run('netstat', ['-ibn']),
    run('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-k', 'Statistics', '-d', '1']),
    run('ioreg', ['-r', '-l', '-w0', '-c', 'IOAccelerator']),
    run('nettop', ['-P', '-L', '1', '-x', '-J', 'bytes_in,bytes_out']),
    helper ? run(helper, ['io']) : Promise.resolve(''),
  ]);
  // One <Link#n> row per network interface holds its byte totals. Counted from the right, since some
  // interfaces have no address column. The loopback (lo0) is the Mac talking to itself: left out.
  let rx = 0, tx = 0;
  for (const line of net.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9 || !/^<Link#\d+>$/.test(f[2]) || /^lo\d/.test(f[0])) continue;
    rx += Number(f[f.length - 5]) || 0;
    tx += Number(f[f.length - 2]) || 0;
  }
  const sum = (text, re) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
  const rd = sum(disk, /"Bytes \(Read\)"=(\d+)/g), wr = sum(disk, /"Bytes \(Write\)"=(\d+)/g);
  // The busiest graphics chip (a Mac with two reports both), and the memory its work is holding.
  const utils = [...gpu.matchAll(/"Device Utilization %"=(\d+)/g)].map((m) => Number(m[1]));
  const gpuMem = sum(gpu, /"In use system memory"=(\d+)/g);
  return {
    rx, tx, rd, wr, gpu: utils.length ? Math.max(...utils) : null, gpuMem: gpuMem || null, hasNet: /<Link#/.test(net), hasDisk: rd + wr > 0,
    perNet: parseNettop(nettop), perDisk: parseIo(io), perGpu: parseGpuClients(gpu), hasPerNet: /bytes_in/.test(nettop), hasPerDisk: !!io,
  };
}
// Running totals → speeds. The whole Mac's, plus each process's since the last look (bytes a second, and
// GPU time as a % of the time that passed). A process seen for the first time, or whose total went down
// (a GPU client closing, a connection's count reset), counts as 0 this once rather than a made-up spike.
function speeds(c, now) {
  const p = S.io;
  S.io = { ...c, at: now };
  const secs = p ? (now - p.at) / 1000 : 0;
  const ok = p && secs > 0.3;
  const rate = (k) => (ok && c[k] >= p[k] ? (c[k] - p[k]) / secs : null);
  const per = (cur, prev, i) => {
    const out = new Map();
    if (!ok) return out;
    for (const [pid, v] of cur) {
      const was = prev.get(pid);
      if (was == null) continue;
      const d = i == null ? v - was : v[i] - was[i];
      if (d > 0) out.set(pid, d / secs);
    }
    return out;
  };
  return {
    gpu: c.gpu, gpuMem: c.gpuMem,
    down: c.hasNet ? rate('rx') : null, up: c.hasNet ? rate('tx') : null,
    read: c.hasDisk ? rate('rd') : null, write: c.hasDisk ? rate('wr') : null,
    ready: !!ok,
    per: {
      down: per(c.perNet, p?.perNet, 0), up: per(c.perNet, p?.perNet, 1),
      read: per(c.perDisk, p?.perDisk, 0), write: per(c.perDisk, p?.perDisk, 1),
      gpu: per(c.perGpu, p?.perGpu), // nanoseconds of GPU work a second
      net: c.hasPerNet, disk: c.hasPerDisk, diskSeen: new Set(c.perDisk.keys()),
    },
  };
}

// The chip, once: "Apple M4 Pro", and how many fast and efficient cores it has.
let chipInfo = null;
async function chip() {
  if (chipInfo) return chipInfo;
  const out = await run('sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.perflevel0.logicalcpu', 'hw.perflevel1.logicalcpu', 'hw.model']);
  const [model, p, e, hw] = out.trim().split('\n');
  chipInfo = { model: model || os.cpus()[0]?.model || 'Unknown', fast: Number(p) || null, efficient: Number(e) || null, hw: hw || null };
  return chipInfo;
}

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
  const appMem = Math.max(0, pages('Anonymous pages') - pages('Pages purgeable'));
  const wired = pages('Pages wired down'), compressed = pages('Pages occupied by compressor');
  const used = Math.min(total, appMem + wired + compressed);
  const mb = (k) => Number(new RegExp(`${k} = ([\\d.]+)M`).exec(swap || '')?.[1] || 0) * 1048576;
  return {
    total,
    used: used > 0 ? used : total - os.freemem(),
    app: appMem, wired, compressed,
    cached: pages('File-backed pages') + pages('Pages purgeable'), // files kept in memory; given back the moment it's needed
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
  // "Maximum Capacity" in System Settings is the nominal capacity over the design one. The raw maximum
  // reads a few points lower than what macOS shows, so it's only the fallback.
  const design = num('DesignCapacity'), max = num('NominalChargeCapacity') || num('AppleRawMaxCapacity');
  const temp = num('Temperature');
  return {
    pct: Number(m[1]),
    plugged: /AC Power/.test(batt),
    charging: state === 'charging' || state === 'finishing charge',
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

// pmset only reports a speed limit on Intel Macs; on Apple silicon it says nothing. So the thermal state
// macOS gives apps (nominal, fair, serious, critical, passed in by main.js) is the main answer, and
// pmset's limit is added where there is one.
async function heat() {
  const out = await run('pmset', ['-g', 'therm']);
  const limit = Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(out)?.[1] || 100);
  const level = /thermal warning level set to (\d+)/i.exec(out)?.[1];
  return { pmsetHot: limit < 100 || (level != null && Number(level) > 0), limit };
}
function heatNow(h, thermal) {
  const state = ['nominal', 'fair', 'serious', 'critical'].includes(thermal) ? thermal : null;
  const throttled = !!h?.pmsetHot || state === 'serious' || state === 'critical';
  return { state, throttled, warm: state === 'fair', limit: h?.limit ?? 100 };
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
    list.push({ pid, display: /Display/.test(m[3]), what: plainReason(m[4]) });
  });
  return list;
}

// What macOS calls the reason ("com.apple.audio…preventuseridlesleep", "Video Wake Lock"), in plain words.
function plainReason(what) {
  if (/audio|sound/i.test(what)) return 'playing sound';
  if (/video|media|playback/i.test(what)) return 'playing a video';
  if (/download|upload|transfer|sync/i.test(what)) return 'transferring files';
  if (/call|meeting|webrtc|camera/i.test(what)) return 'a call';
  if (/wake ?lock|display|screen/i.test(what)) return 'keeping the screen on';
  return 'something it’s doing'; // the rest are internal names ("Electron", "NoIdleSleepAssertion")
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
async function sample({ selfPid, thermal, display } = {}) {
  startTicker();
  const [psOut, appsOut, mem, slow, gpuOut, feet, io, chipNow] = await Promise.all([
    run('ps', ['-Axo', 'pid=,ppid=,pcpu=,time=,rss=,comm=']),
    run('lsappinfo', ['list']),
    memory(),
    slowStats(),
    // Graphics (GPU) parts of Chrome and Electron apps: marked by how they were started, not by name.
    run('pgrep', ['-f', '--', '--type=gpu-process']),
    footprints(),
    counters(),
    chip(),
  ]);
  const gpuPids = new Set(gpuOut.split('\n').map(Number).filter(Boolean));
  const now = Date.now();
  const procs = parsePs(psOut);
  const apps = parseApps(appsOut);
  const cores = os.cpus().length || 1;
  const totals = cpuTotals();
  const memOf = (p) => feet.get(p.pid) ?? p.rss; // its footprint; RSS only for a process newer than top's last look

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
  const L = speeds(io, now);
  const zeroIo = () => ({ down: 0, up: 0, read: 0, write: 0, gpuNs: 0, diskSeen: 0 });
  const addIo = (t, pid) => {
    t.down += L.per.down.get(pid) || 0; t.up += L.per.up.get(pid) || 0;
    t.read += L.per.read.get(pid) || 0; t.write += L.per.write.get(pid) || 0;
    t.gpuNs += L.per.gpu.get(pid) || 0;
    if (L.per.diskSeen.has(pid)) t.diskSeen++;
  };
  const groups = new Map(apps.map((a) => [a.pid, { ...a, cpu: 0, mem: 0, gpu: 0, procs: 0, io: zeroIo() }]));
  const systemIo = zeroIo();
  const cats = new Map(); // category id -> { cpu, mem, count, names: Map(name -> { cpu, mem, count }) }
  let systemCpu = 0, systemMem = 0, systemCount = 0;
  for (const p of procs.values()) {
    const c = cpuOf(p), m = memOf(p);
    const a = owner(p);
    if (a) {
      const g = groups.get(a.pid);
      g.cpu += c; g.mem += m; g.procs++;
      if (gpuPids.has(p.pid)) g.gpu += m;
      addIo(g.io, p.pid);
      continue;
    }
    systemCpu += c; systemMem += m; systemCount++;
    addIo(systemIo, p.pid);
    const { cat, name } = categorize(p.exe);
    const k = cats.get(cat.id) || { cpu: 0, mem: 0, count: 0, names: new Map() };
    k.cpu += c; k.mem += m; k.count++;
    const n = k.names.get(name) || { cpu: 0, mem: 0, count: 0 };
    n.cpu += c; n.mem += m; n.count++;
    k.names.set(name, n);
    cats.set(cat.id, k);
  }

  const share = (oneCore) => Math.min(100, oneCore / cores); // % of the whole Mac
  const r1 = (v) => Math.round(v * 10) / 10;
  const blockersByPid = new Map();
  for (const b of slow.blockers) {
    const pr = procs.get(b.pid);
    const a = pr ? owner(pr) : byPid.get(b.pid);
    const key = a ? a.pid : null;
    if (key) (blockersByPid.get(key) || blockersByPid.set(key, []).get(key)).push(b.what);
  }
  // One app's (or the background's) own network, disk and GPU, in the same shape as the whole Mac's.
  // Disk is "partial" when some of its parts couldn't be read (macOS's root tasks, for the background).
  const liveOf = (t, count) => (L.ready ? {
    down: L.per.net ? t.down : null, up: L.per.net ? t.up : null,
    read: L.per.disk ? t.read : null, write: L.per.disk ? t.write : null,
    gpu: Math.min(100, Math.round(t.gpuNs / 1e7)), // ns of GPU work a second → % of the GPU's time
    diskPartial: L.per.disk && t.diskSeen < count,
  } : { down: null, up: null, read: null, write: null, gpu: null, diskPartial: false });
  const live = new Set();
  const list = [...groups.values()].map((g) => {
    const key = g.bundle || g.name;
    live.add(key);
    const hist = push(S.appHistory.get(key) || [], { t: now, v: r1(share(g.cpu)) });
    S.appHistory.set(key, hist);
    return {
      key, pid: g.pid, name: g.name, bundle: g.bundle, path: g.path, kind: g.kind,
      cpu: r1(share(g.cpu)), core: Math.round(g.cpu), mem: g.mem, gpu: g.gpu, procs: g.procs,
      history: hist.map((p) => p.v), trail: trailOf(hist, now), icon: iconFor(g.path), self: g.pid === selfPid,
      awake: [...new Set(blockersByPid.get(g.pid) || [])],
      live: liveOf(g.io, g.procs),
    };
  });
  // Everything that isn't an app, as one entry ("Background") made of categories, each naming its busiest parts.
  const sysHist = push(S.appHistory.get('macos') || [], { t: now, v: r1(share(systemCpu)) });
  S.appHistory.set('macos', sysHist);
  live.add('macos');
  for (const k of S.appHistory.keys()) if (!live.has(k)) S.appHistory.delete(k);
  const parts = [...cats].map(([id, k]) => {
    const c = CAT_BY_ID[id];
    const top = [...k.names].sort((a, b) => b[1].cpu - a[1].cpu || b[1].mem - a[1].mem).slice(0, 3)
      .map(([name, n]) => ({ name, cpu: r1(share(n.cpu)), core: Math.round(n.cpu), mem: n.mem, count: n.count }));
    return { id, name: id, label: c.label, about: c.about, passes: !!c.passes, cpu: r1(share(k.cpu)), core: Math.round(k.cpu), mem: k.mem, count: k.count, top };
  }).sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  list.push({
    key: 'macos', pid: 0, name: 'Background', bundle: null, path: null, system: true,
    cpu: r1(share(systemCpu)), core: Math.round(systemCpu), mem: systemMem,
    procs: systemCount, history: sysHist.map((p) => p.v), trail: trailOf(sysHist, now), icon: null, awake: [], parts,
    live: liveOf(systemIo, systemCount),
  });
  list.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);

  const snap = {
    at: now, cores, uptime: os.uptime(), chip: chipNow, load: os.loadavg().map((v) => Math.round(v * 100) / 100),
    cpu: { total: Math.round(total), history: [...S.history], trail: cpuTrail },
    mem, battery: slow.battery, disk: slow.disk, heat: heatNow(slow.heat, thermal),
    live: { gpu: L.gpu, gpuMem: L.gpuMem, down: L.down, up: L.up, read: L.read, write: L.write }, display: display || null, procCount: procs.size,
    apps: list, appCount: apps.length, memExact: feet.size > 0,
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
  if (s.heat?.state === 'critical') hit(40, 'Overheating');
  else if (s.heat?.throttled) hit(30, 'Running hot');
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
  sample, frontApp, fix, isBrowser, startTicker, tickCpu, warm, TRAIL_MS,
  setIconLoader: (fn) => { iconLoader = fn; },
  setHelper: (fn) => { helperFor = fn; },
  _test: { parseApps, parsePs, cpuSeconds, parseTop, categorize, counters, heatNow, parseNettop, parseIo, parseGpuClients },
};
