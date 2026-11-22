// Updates from GitHub releases. Pane is signed only locally, so Electron's built-in updater
// (which needs an Apple Developer signature) can't be used. Instead:
//   1. ask GitHub for the newest release; if it's newer, the settings window shows Pane's own update
//      sheet with what changed since this version
//   2. on "Update and Restart": if the release has a small patch from this version (Pane-<this>-to-<new>.patch,
//      see app-patch.js), download that and rebuild the new Pane.app from this one; otherwise (or if that
//      goes wrong) download the whole Pane.dmg and copy Pane.app out of it. Either way, check it's the
//      version we expect and properly signed
//   3. put it where this Pane.app is (or in /Applications, if Pane is running from the disk image) and reopen
const { app, net, BrowserWindow } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('original-fs'); // plain fs treats app.asar as a folder, which breaks copying and removing apps
const os = require('os');
const path = require('path');
const AppPatch = require('./app-patch.js');

const REPO = 'HFang1012/Pane-Mac';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const FIRST_CHECK = 15 * 1000;
const EVERY = 6 * 60 * 60 * 1000;

let store = { get: () => ({}), set: () => {} };
let onState = () => {};
let reveal = () => {};
let timer = null;
let latestAsset = null;
let latestAssets = [];

// What the settings window shows. status: idle | checking | current | available | downloading | installing | error
let state = { status: 'idle', version: '', notes: [], progress: 0, error: '', open: false };
const get = () => ({ ...state, current: currentVersion(), canInstall: canInstall() });
function set(patch) {
  state = { ...state, ...patch };
  onState(get());
}

// Lets the update flow be tried from a dev build: PANE_PRETEND_VERSION=1.0.0 npm start
const currentVersion = () => process.env.PANE_PRETEND_VERSION || app.getVersion();

function parse(v) {
  return String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}
function newer(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout))));

// ---------- where the update goes ----------
// The Pane.app this process is running from (…/Pane.app/Contents/MacOS/Pane).
const bundlePath = () => path.resolve(app.getPath('exe'), '..', '..', '..');
const canInstall = () => app.isPackaged && bundlePath().endsWith('.app');
// Running from the disk image, or from the hidden read-only copy macOS makes of an app that was
// never moved (App Translocation): the update goes to /Applications instead.
function installTarget() {
  const b = bundlePath();
  if (b.startsWith('/Volumes/') || b.includes('/AppTranslocation/')) return '/Applications/Pane.app';
  return b;
}
function writable(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}

// ---------- asking GitHub ----------
async function fetchReleases() {
  const res = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pane-updater' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again in a little while.`);
  return (await res.json()).filter((r) => !r.draft && !r.prerelease && /^v?\d+(\.\d+)*$/.test(r.tag_name));
}

// Every release newer than this one, newest first: [{ version, items: [...] }]
function changelog(releases, from) {
  return releases
    .filter((r) => newer(r.tag_name, from))
    .sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : 1))
    .map((r) => {
      const items = String(r.body || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[-*]\s+/.test(l) && !/Full Changelog/i.test(l))
        .map((l) => l.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''));
      return { version: r.tag_name.replace(/^v/, ''), items: items.length ? items : ['Small fixes and improvements'] };
    });
}

// ---------- the check ----------
async function check({ manual = false } = {}) {
  if (['checking', 'downloading', 'installing'].includes(state.status)) { if (manual) { set({ open: true }); reveal(true); } return; }
  const was = state;
  set({ status: 'checking', error: '', open: manual || was.open });
  if (manual) reveal(true);
  try {
    const releases = await fetchReleases();
    const have = currentVersion();
    const latest = releases.reduce((best, r) => (!best || newer(r.tag_name, best.tag_name) ? r : best), null);
    if (!latest || !newer(latest.tag_name, have)) {
      set({ status: 'current', version: '', notes: [], open: manual });
      return;
    }
    const version = latest.tag_name.replace(/^v/, '');
    latestAssets = latest.assets || [];
    latestAsset = latestAssets.find((a) => a.name.endsWith('.dmg')) || null;
    // Pops up by itself once per version, unless skipped; the update button in the corner always offers it.
    const seen = was.version === version;
    const popUp = manual || (!seen && store.get().skipped !== version);
    set({ status: 'available', version, notes: changelog(releases, have), progress: 0, open: popUp || was.open });
    if (popUp) reveal(manual);
  } catch (err) {
    console.warn('Update check failed:', err.message);
    // A background check that fails stays quiet, and keeps offering any update it found before.
    if (manual) set({ status: 'error', error: `Couldn't check for updates. ${err.message}`, open: true });
    else set({ status: was.version ? 'available' : 'idle', open: was.open });
  }
}

function later() { set({ open: false }); }
function skip() {
  if (state.version) store.set({ ...store.get(), skipped: state.version });
  set({ open: false });
}
function open() {
  if (state.version || state.status === 'checking') set({ open: true });
  else check({ manual: true });
}

// ---------- download and swap ----------
let lastSent = 0;
function progress(p) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(p);
  const now = Date.now();
  if (p >= 0 && p <= 1 && (now - lastSent > 80 || p === 1)) { lastSent = now; set({ progress: p }); }
}

async function download(url, size, to) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Pane-updater' } });
  if (!res.ok || !res.body) throw new Error(`The download didn't start (${res.status}).`);
  const out = fs.createWriteStream(to);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (size) progress(Math.min(got / size, 1));
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (size && got !== size) throw new Error('The download was cut short.');
}

// The small way: download the patch from this version and rebuild the new Pane.app next to it.
async function fromPatch(asset, staged, work) {
  const file = path.join(work, 'update.patch');
  await download(asset.browser_download_url, asset.size, file);
  AppPatch.apply(file, bundlePath(), staged);
  fs.rmSync(file, { force: true });
}

// The whole way: download Pane.dmg and copy Pane.app out of it.
async function fromDmg(asset, staged, work) {
  const dmgFile = path.join(work, 'Pane.dmg');
  const mount = path.join(work, 'mnt');
  await download(asset.browser_download_url, asset.size, dmgFile);
  fs.mkdirSync(mount);
  await run('hdiutil', ['attach', dmgFile, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
  try {
    await run('ditto', [path.join(mount, 'Pane.app'), staged]);
  } finally {
    await run('hdiutil', ['detach', mount, '-force']).catch(() => {});
  }
  fs.rmSync(dmgFile, { force: true });
}

// Downloads the release and puts the new Pane.app in a private folder. Returns where it put it.
// `patch` is the release's patch from this version, if it has one.
async function prepare(asset, version, patch = null) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-update-'));
  const staged = path.join(work, 'Pane.app');
  try {
    let done = false;
    if (patch && canInstall()) {
      try {
        await fromPatch(patch, staged, work);
        await run('codesign', ['--verify', '--deep', '--strict', staged]);
        done = true;
      } catch (err) {
        console.warn('Small update failed, downloading the whole app instead:', err.message);
        fs.rmSync(staged, { recursive: true, force: true });
        progress(0);
      }
    }
    if (!done) await fromDmg(asset, staged, work);
    const built = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.join(staged, 'Contents', 'Info.plist')])).trim();
    if (built !== version) throw new Error(`The download is version ${built}, not ${version}.`);
    await run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
    return { work, staged };
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw err;
  }
}

// Puts the new app in place. The old one is set aside first and comes back if anything fails,
// so Pane is never left missing.
const SWAP = `
old="$WORK/Pane-old.app"
if [ -e "$TARGET" ]; then mv "$TARGET" "$old" || exit 1; fi
if mv "$STAGED" "$TARGET"; then rm -rf "$old"; else [ -e "$old" ] && mv "$old" "$TARGET"; exit 1; fi
`;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
async function swapIn({ work, staged, target }) {
  const script = `WORK=${shq(work)}; TARGET=${shq(target)}; STAGED=${shq(staged)}; ${SWAP}`;
  if (writable(path.dirname(target)) && (!fs.existsSync(target) || writable(target))) {
    await run('/bin/sh', ['-c', script]);
  } else {
    // The folder belongs to an administrator: macOS asks for a password once to put the update there.
    const quoted = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await run('osascript', ['-e', `do shell script "${quoted}" with administrator privileges`]);
  }
}

// Once this process has quit, open the new app and tidy up.
function reopenAfterExit({ work, target, pid, openIt = true }) {
  const script = 'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done; [ -n "$NO_OPEN" ] || open "$TARGET"; rm -rf "$WORK"';
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, PID: String(pid), WORK: work, TARGET: target, NO_OPEN: openIt ? '' : '1' },
  });
  child.unref();
}

async function install() {
  if (state.status !== 'available' && state.status !== 'error') return;
  if (!latestAsset) { await check({ manual: true }); if (!latestAsset) return; }
  if (!canInstall()) { set({ status: 'error', error: 'Updates install from the Pane app, not a development build.', open: true }); return; }
  let ready;
  const target = installTarget();
  try {
    set({ status: 'downloading', progress: 0, error: '', open: true });
    const patch = latestAssets.find((a) => a.name === `Pane-${currentVersion()}-to-${state.version}.patch`) || null;
    ready = await prepare(latestAsset, state.version, patch);
    set({ status: 'installing' });
    progress(2); // the Dock's bar spins while it's put in place
    // Swapping a running app's bundle is safe on macOS: this process keeps its files open until it quits.
    await swapIn({ ...ready, target });
  } catch (err) {
    progress(-1);
    if (ready) fs.rmSync(ready.work, { recursive: true, force: true });
    const cancelled = /User canceled|-128/.test(err.message);
    set({ status: 'error', error: cancelled ? 'The update needs your Mac password to finish.' : `The update didn't finish. ${err.message}` });
    return;
  }
  progress(-1);
  reopenAfterExit({ work: ready.work, target, pid: process.pid });
  app.quit();
}

// ---------- wiring ----------
function start(opts = {}) {
  if (opts.store) store = opts.store;
  if (opts.onState) onState = opts.onState;
  if (opts.reveal) reveal = opts.reveal;
  if (!app.isPackaged && !process.env.PANE_PRETEND_VERSION) return; // dev builds don't check by themselves
  setTimeout(() => check(), FIRST_CHECK);
  clearInterval(timer);
  timer = setInterval(() => check(), EVERY);
}

module.exports = { start, check, get, install, later, skip, open, newer, changelog, _test: { fetchReleases, prepare, swapIn, reopenAfterExit } };
