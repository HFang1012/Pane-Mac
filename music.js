// Spin's link to your music app (main process only).
//
// Spotify and Apple Music are driven with Apple Events (osascript), so they need no setup beyond the
// one-time "Pane wants to control Spotify" prompt. Any other player gets the media keys, like the
// keys on the keyboard, and the Mac's own volume.
//
// The list of songs (what's coming and what's been) comes from Music's current playlist. Spotify keeps
// its queue to itself, so for Spotify the list needs its Web API: you link your account once, with a
// Client ID from your own free Spotify developer app (Pane has no server and holds no secrets).
const { execFile } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const APPS = {
  spotify: { name: 'Spotify', bundle: 'com.spotify.client' },
  music: { name: 'Music', bundle: 'com.apple.Music' },
  other: { name: 'Media keys' },
};

function osa(src, { js = true, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('osascript', [...(js ? ['-l', 'JavaScript'] : []), '-e', src], { timeout }, (err, out, errOut) => {
      if (err) {
        const e = new Error((errOut || err.message || '').trim());
        // -1743: macOS hasn't let Pane control this app (Privacy & Security › Automation).
        e.denied = /-1743|not allowed|Not authorized/i.test(e.message);
        reject(e);
      } else resolve(String(out).trim());
    });
  });
}
const lit = (v) => JSON.stringify(v); // a safe literal to put inside a JXA script

// ---------- now playing ----------
const STATE = {
  spotify: `(() => {
    const s = Application('Spotify');
    if (!s.running()) return JSON.stringify({ running: false });
    const out = { running: true, state: String(s.playerState()), volume: s.soundVolume() };
    try { out.shuffle = s.shuffling(); } catch (e) {}
    try { out.repeat = s.repeating() ? 'context' : 'off'; } catch (e) {}
    try {
      const t = s.currentTrack();
      out.track = { title: t.name(), artist: t.artist(), album: t.album(), id: t.id(), art: t.artworkUrl() };
    } catch (e) {}
    return JSON.stringify(out);
  })()`,
  music: `(() => {
    const m = Application('Music');
    if (!m.running()) return JSON.stringify({ running: false });
    const out = { running: true, state: String(m.playerState()), volume: m.soundVolume() };
    try { out.shuffle = m.shuffleEnabled(); } catch (e) {}
    try { out.repeat = String(m.songRepeat()); } catch (e) {} // 'off' | 'one' | 'all'
    try {
      const t = m.currentTrack();
      out.track = { title: t.name(), artist: t.artist(), album: t.album(), id: t.persistentID() };
    } catch (e) {}
    try {
      const p = m.currentPlaylist();
      out.playlist = { id: p.persistentID(), name: p.name(), size: p.tracks.length };
    } catch (e) {}
    return JSON.stringify(out);
  })()`,
  other: `(() => {
    const a = Application.currentApplication(); a.includeStandardAdditions = true;
    return JSON.stringify({ running: true, state: 'unknown', volume: a.getVolumeSettings().outputVolume });
  })()`,
};

// The media keys, posted the way the keyboard posts them (needs the Accessibility access Pane has).
const MEDIA_KEY = { toggle: 16, next: 17, prev: 18 };
const mediaKey = (code) => `ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
  [true, false].forEach((down) => {
    const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
      14, $.NSMakePoint(0, 0), down ? 0xa00 : 0xb00, 0, 0, null, 8, (${code} << 16) | ((down ? 0xa : 0xb) << 8), -1);
    $.CGEventPost(0, ev.CGEvent);
  }); 'ok'`;

const ACTIONS = {
  spotify: {
    toggle: `Application('Spotify').playpause()`,
    next: `Application('Spotify').nextTrack()`,
    prev: `Application('Spotify').previousTrack()`,
    volume: (v) => `Application('Spotify').soundVolume = ${Number(v)}`,
  },
  music: {
    toggle: `Application('Music').playpause()`,
    next: `Application('Music').nextTrack()`,
    prev: `Application('Music').previousTrack()`,
    volume: (v) => `Application('Music').soundVolume = ${Number(v)}`,
  },
  other: {
    toggle: mediaKey(MEDIA_KEY.toggle),
    next: mediaKey(MEDIA_KEY.next),
    prev: mediaKey(MEDIA_KEY.prev),
    volume: (v) => `const a = Application.currentApplication(); a.includeStandardAdditions = true; a.setVolume(null, { outputVolume: ${Number(v)} })`,
  },
};

// ---------- the cache the wheel reads ----------
// The wheel opens at once with what's known, and fills in when a fresh look comes back.
const cache = { app: null, np: null, list: null, error: null, at: 0 };
let listeners = [];
const onChange = (fn) => listeners.push(fn);
const emit = () => listeners.forEach((fn) => fn(snapshot()));
const snapshot = () => ({ app: cache.app, np: cache.np, list: cache.list, error: cache.error });

let musicLists = { key: '', items: null }; // Music's current playlist, kept until it changes
let musicArt = { id: null, url: null };

let inflight = null;
function refresh(appId) {
  if (inflight && inflight.appId === appId) return inflight.p;
  const p = (async () => {
    if (cache.app !== appId) Object.assign(cache, { app: appId, np: null, list: null, error: null });
    try {
      const np = JSON.parse(await osa(STATE[appId]));
      cache.error = null;
      if (appId === 'music' && np.track) {
        np.track.art = await musicArtwork(np.track.id);
      }
      cache.np = np;
      emit();
      cache.list = np.running ? await listFor(appId, np) : null;
    } catch (err) {
      cache.error = err.denied ? 'denied' : 'failed';
      if (!err.denied) console.warn('Spin: music app check failed:', err.message);
    }
    cache.at = Date.now();
    emit();
    return snapshot();
  })().finally(() => { if (inflight?.p === p) inflight = null; });
  inflight = { appId, p };
  return p;
}

async function listFor(appId, np) {
  try {
    if (appId === 'music') return await musicList(np);
    if (appId === 'spotify') return await spotifyList(np);
  } catch (err) {
    console.warn('Spin: song list failed:', err.message);
  }
  return null;
}

// ---------- Apple Music ----------
async function musicList(np) {
  if (!np.playlist || !np.track) return null;
  const key = `${np.playlist.id}:${np.playlist.size}`;
  if (musicLists.key !== key) {
    const out = JSON.parse(await osa(`(() => {
      const p = Application('Music').currentPlaylist();
      return JSON.stringify({ names: p.tracks.name(), artists: p.tracks.artist(), ids: p.tracks.persistentID() });
    })()`, { timeout: 15000 }));
    musicLists = {
      key,
      items: out.names.map((title, i) => ({ title, artist: out.artists[i], id: out.ids[i], pos: i })),
    };
  }
  const all = musicLists.items;
  const i = all.findIndex((t) => t.id === np.track.id);
  if (i < 0) return null;
  // Repeating the playlist: what comes after the last song is the first one again, and before the
  // first, the last. Unrolled into one straight list, each song once either way.
  const loop = np.repeat === 'all' && all.length > 1;
  const after = loop ? [...all.slice(i + 1), ...all.slice(0, i)] : all.slice(i + 1);
  const before = loop ? [...all.slice(i + 1), ...all.slice(0, i)] : all.slice(0, i);
  const items = [...before, all[i], ...after];
  return { source: 'music', name: np.playlist.name, playlistId: np.playlist.id, items, index: before.length, loop };
}
// Music hands over the cover as raw image data; Pane writes it to a file once per song.
async function musicArtwork(id) {
  if (musicArt.id === id) return musicArt.url;
  musicArt = { id, url: null };
  const file = path.join(app.getPath('temp'), `pane-spin-art-${process.pid}`);
  try {
    const ok = await osa(`if application "Music" is running then
      tell application "Music"
        try
          set d to raw data of artwork 1 of current track
        on error
          return ""
        end try
      end tell
      set f to open for access (POSIX file ${lit(file)}) with write permission
      set eof f to 0
      write d to f
      close access f
      return "ok"
    end if
    return ""`, { js: false });
    if (ok === 'ok') {
      const buf = fs.readFileSync(file);
      const type = buf[0] === 0x89 ? 'png' : 'jpeg';
      if (buf.length < 3_000_000) musicArt.url = `data:image/${type};base64,${buf.toString('base64')}`;
    }
  } catch {}
  return musicArt.url;
}

// ---------- actions ----------
let volBusy = false, volNext = null;
async function act(appId, cmd, arg) {
  const a = ACTIONS[appId];
  if (!a) return;
  if (cmd === 'volume') {
    // Sliding along the arc sends lots of values: keep one in flight, and only the newest waiting.
    volNext = Math.round(Math.max(0, Math.min(100, arg)));
    if (cache.np) cache.np.volume = volNext;
    if (volBusy) return;
    volBusy = true;
    try {
      while (volNext != null) {
        const v = volNext; volNext = null;
        await osa(a.volume(v)).catch(() => {});
      }
    } finally { volBusy = false; }
    return;
  }
  try {
    await keepFront(appId, () => osa(a[cmd]));
  } catch (err) {
    if (err.denied) cache.error = 'denied';
    console.warn(`Spin: ${cmd} failed:`, err.message);
  }
  setTimeout(() => refresh(appId), 350); // let the app settle, then look again
}

// ---------- staying in your app ----------
// Spotify's "play track" (and sometimes Music's "play") brings its window to the front. Spin is for
// changing songs without leaving what you're doing, so note the app in front first and, if the music
// app takes over, hand the front straight back.
// All of this goes through AppKit's list of running apps (lsappinfo and NSRunningApplication), not
// Apple Events: telling another app to activate would need Pane to be allowed to control that app too,
// and without that the hand-back silently failed and left Spotify in front.
function frontBundle() {
  return new Promise((resolve) => {
    execFile('lsappinfo', ['front'], (err, asn) => {
      if (err || !asn.trim()) return resolve(null);
      execFile('lsappinfo', ['info', '-only', 'bundleid', asn.trim()], (err2, out) => {
        resolve((!err2 && /"CFBundleIdentifier"="([^"]+)"/.exec(out)?.[1]) || null);
      });
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const running = (bundle, body) => osa(`ObjC.import('AppKit');
  const list = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${lit(bundle)});
  const app = list.count ? list.objectAtIndex(0) : null;
  app ? String((() => { ${body} })()) : ''`);
const isHidden = (bundle) => running(bundle, 'return app.hidden;').then((x) => x === 'true').catch(() => false);
const hideApp = (bundle) => running(bundle, 'app.hide; return "ok";').catch(() => {});
// Bring `bundle` forward. Newer macOS only lets an app come forward when the active one gives way,
// so try, in turn: AppKit, LaunchServices (`open -b`, which isn't held to that), then Apple Events.
const openBundle = (bundle) => new Promise((resolve) => execFile('open', ['-b', bundle], () => resolve()));
async function giveFront(bundle) {
  await running(bundle, 'app.activateWithOptions($.NSApplicationActivateAllWindows); return "ok";').catch(() => {});
  await wait(60);
  if ((await frontBundle()) === bundle) return;
  await openBundle(bundle);
  await wait(80);
  if ((await frontBundle()) === bundle) return;
  await osa(`tell application id ${lit(bundle)} to activate`, { js: false }).catch(() => {});
}
// Pane itself (the built app, or Electron while working on it). Never handed the front through
// LaunchServices or Apple Events: `open -b` on Pane counts as a Dock click, which shows the settings
// window and carries you to whichever Space it's on. Pane brings itself back through `selfFront`.
const isSelf = (id) => id === 'com.pane.app' || !!id?.startsWith('com.github.Electron');
let selfFront = () => false;
function onSelfFront(fn) { selfFront = fn; }
async function keepFront(appId, run, { watch = 3000 } = {}) {
  const musicBundle = APPS[appId]?.bundle;
  const before = musicBundle ? await frontBundle() : null;
  if (!before || before === musicBundle) return run();
  const wasHidden = await isHidden(musicBundle);
  await run();
  // The music app can come forward late (a playlist loading), and more than once (Spotify does it
  // twice), so keep watching for a while after each hand-back.
  let until = Date.now() + watch;
  while (Date.now() < until) {
    await wait(40);
    if ((await frontBundle()) === musicBundle) {
      // Hidden before? Hide it again: macOS then hands the front back by itself.
      if (wasHidden) await hideApp(musicBundle);
      if ((await frontBundle()) === musicBundle) {
        // Pane was in front (a Tweak editor, say): it takes the front back itself if one of its windows is
        // still up to take it; otherwise the music app steps aside and macOS picks an app on this Space.
        if (isSelf(before)) { if (!selfFront()) await hideApp(musicBundle); }
        else await giveFront(before);
      }
      until = Math.max(until, Date.now() + 1000);
    }
  }
}

// Skipping ahead a few songs in one go (one osascript, no window coming forward).
const skip = (appName, n) => `(() => { const a = Application(${lit(appName)}); for (let i = 0; i < ${Number(n)}; i++) { a.nextTrack(); delay(0.05); } })()`;
const SKIP_MAX = 8;
// Spotify's next and previous never bring its window forward (its "play track" does). So when the
// list is in play order, reach a song by stepping to it: forward with next, back with previous
// (from the start of the song, so each previous is one song back). Muted while it steps, so you
// don't hear a blip of every song on the way; the volume comes back once it's there.
const STEP_MAX = 60;
const spotifySteps = (n) => `(() => {
  const a = Application('Spotify');
  const steps = ${Number(n)}, count = Math.abs(steps);
  let vol = null;
  try { vol = a.soundVolume(); } catch (e) {}
  try {
    if (count > 1 && vol != null) a.soundVolume = 0;
    if (steps < 0) a.playerPosition = 0;
    for (let i = 0; i < count; i++) { if (steps > 0) a.nextTrack(); else a.previousTrack(); delay(0.06); }
  } finally {
    if (count > 1 && vol != null) { delay(0.12); a.soundVolume = vol; }
  }
  return 'ok';
})()`;

/** Plays the song at `at` in `list` (as built by musicList / spotifyList). */
async function playAt(appId, list, at) {
  const item = list?.items?.[at];
  if (!item) return;
  const ahead = at - list.index;
  try {
    const reachable = list.source === 'spotify' && ahead !== 0 && Math.abs(ahead) <= STEP_MAX &&
      (list.ordered || (ahead > 0 && item.skip === ahead));
    if (reachable) {
      // In play order (or in Spotify's queue): step there with next / previous. Keeps the queue and
      // the playlist as they are, and Spotify's window stays where it is.
      await osa(spotifySteps(ahead), { timeout: 20000 });
    } else await keepFront(appId, () => playOne(list, item, ahead));
  } catch (err) {
    console.warn('Spin: play failed:', err.message);
  }
  setTimeout(() => refresh(appId), 400);
}
// Starting playback through Spotify's Web API changes the song without touching Spotify's window.
// It needs Spotify Premium, a device that's on, and the playback permission (added to the link in
// 1.4.2; links made before can't, until you link again). When it can't, Spin falls back to AppleScript.
async function spotifyApiPlay(body) {
  try {
    await apiSend('PUT', '/me/player/play', body);
    return true;
  } catch (err) {
    console.warn('Spin: Spotify Web API play didn’t work, using AppleScript:', err.message);
    return false;
  }
}
async function playOne(list, item, ahead) {
  if (list.source === 'music') {
    await osa(`(() => {
      const m = Application('Music');
      const p = m.playlists.whose({ persistentID: ${lit(list.playlistId)} })[0];
      m.play(p.tracks[${Number(item.pos)}]);
    })()`);
  } else if (list.source === 'spotify') {
    if (item.skip === ahead && ahead > 0 && ahead <= 30) {
      // Further into the queue: Spotify can't jump there, but skipping keeps the queue as it is.
      await osa(skip('Spotify', ahead), { timeout: 15000 });
    } else if (item.ctx && list.context) {
      // A song of the playlist or album: play it there, so the rest of it follows.
      if (await spotifyApiPlay({ context_uri: list.context, offset: { uri: item.uri } })) return;
      await osa(`Application('Spotify').playTrack(${lit(item.uri)}, { inContext: ${lit(list.context)} })`);
    } else {
      if (await spotifyApiPlay({ uris: [item.uri] })) return;
      await osa(`Application('Spotify').playTrack(${lit(item.uri)})`);
    }
  }
}

// ---------- playlists: the chooser on the Spin page ----------
// Music lists your own playlists over Apple Events; Spotify's come from its Web API (so it needs the
// same link as the song list). Kept for a minute so flipping pages doesn't ask again.
let spotifyNowCtx = null; // the playlist or album Spotify is playing from, as the Web API last said
let lists = { app: null, at: 0, data: null };
async function playlists(appId, { fresh = false } = {}) {
  if (!fresh && lists.app === appId && lists.data && Date.now() - lists.at < 60 * 1000) return withCurrent(appId, lists.data);
  let data;
  try {
    if (appId === 'music') data = await musicPlaylists();
    else if (appId === 'spotify') data = await spotifyPlaylists();
    else data = { unsupported: true };
  } catch (err) {
    if (err.denied) return { error: 'denied' };
    console.warn('Spin: playlists failed:', err.message);
    return { error: 'failed' };
  }
  if (data.items) lists = { app: appId, at: Date.now(), data };
  return withCurrent(appId, data);
}
function withCurrent(appId, data) {
  const current = appId === 'music' ? cache.np?.playlist?.id ?? null : appId === 'spotify' ? spotifyNowCtx : null;
  return { ...data, current };
}
async function musicPlaylists() {
  const out = JSON.parse(await osa(`(() => {
    const m = Application('Music');
    if (!m.running()) return JSON.stringify({ running: false });
    const p = m.userPlaylists;
    return JSON.stringify({ running: true, names: p.name(), ids: p.persistentID(), kinds: p.specialKind() });
  })()`, { timeout: 15000 }));
  if (!out.running) return { running: false };
  // Your own playlists (smart ones too), not the library, folders or Apple's built-in lists.
  const items = out.names
    .map((name, i) => ({ id: out.ids[i], name, kind: String(out.kinds[i]) }))
    .filter((p) => p.kind === 'none' && p.name)
    .map(({ id, name }) => ({ id, name }));
  return { running: true, items };
}
async function spotifyPlaylists() {
  if (!spotifyAccount().connected) return { needsLink: true };
  const items = [];
  let page = await api('/me/playlists?limit=50');
  while (page) {
    for (const p of page.items || []) {
      if (!p?.uri) continue;
      items.push({ id: p.uri, name: p.name, art: pickImage(p.images), count: p.tracks?.total ?? p.items?.total ?? null });
    }
    page = page.next && items.length < 200 ? await api(page.next) : null;
  }
  return { running: true, items };
}
/** Starts a playlist from the top, staying in the app you're in. */
async function playPlaylist(appId, id) {
  try {
    if (appId === 'music') {
      if (!/^[0-9A-F]{16}$/i.test(String(id))) return { ok: false };
      await keepFront(appId, () => osa(`(() => {
        const m = Application('Music');
        const p = m.playlists.whose({ persistentID: ${lit(id)} })[0];
        m.play(p);
      })()`));
    } else if (appId === 'spotify') {
      if (!/^spotify:(user:[^:]+:)?playlist:[0-9A-Za-z]+$/.test(String(id))) return { ok: false };
      if (!(await spotifyApiPlay({ context_uri: id }))) {
        await keepFront(appId, () => osa(`Application('Spotify').playTrack(${lit(id)})`));
      }
      spotifyNowCtx = id;
    } else return { ok: false };
  } catch (err) {
    console.warn('Spin: playing the playlist failed:', err.message);
    return { ok: false, error: err.denied ? 'denied' : 'failed' };
  }
  await wait(450);
  await refresh(appId);
  return { ok: true, current: withCurrent(appId, {}).current };
}

// ---------- Spotify Web API (only for the song list) ----------
const SPOTIFY_PORT = 43117;
const REDIRECT = `http://127.0.0.1:${SPOTIFY_PORT}/callback`;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played playlist-read-private playlist-read-collaborative';
const tokenFile = () => path.join(app.getPath('userData'), 'spotify.json');
let tokens = null; // { clientId, access, refresh, expires, name }

// Kept as plain JSON that only you can read (mode 600), not in the Keychain: Pane is signed locally, so
// every build looks like a new app to the Keychain and it would ask for your password on each launch.
// A link saved by an older Pane was encrypted; it can't be read without the Keychain, so it's dropped
// and Spotify asks to be linked once more.
function loadTokens() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  } catch (e) {
    tokens = null;
    if (e.code !== 'ENOENT') try { fs.rmSync(tokenFile()); } catch {}
  }
  return tokens;
}
function saveTokens(t) {
  tokens = t;
  fs.writeFileSync(tokenFile(), JSON.stringify(t), { mode: 0o600 });
  try { fs.chmodSync(tokenFile(), 0o600); } catch {}
}
function spotifyAccount() {
  const t = loadTokens();
  // canPlay: linked with the playback permission, so songs and playlists start without Spotify's window.
  // Unknown (an old link not yet refreshed) counts as yes until Spotify says otherwise.
  const canPlay = !t?.scope || t.scope.split(' ').includes('user-modify-playback-state');
  return t?.refresh ? { connected: true, name: t.name || null, clientId: t.clientId, canPlay } : { connected: false };
}
function disconnectSpotify() {
  tokens = null;
  try { fs.rmSync(tokenFile()); } catch {}
  spotifyCtx = { uri: null, items: null, at: 0 };
  spotifyNowCtx = null;
  lists = { app: null, at: 0, data: null };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let authServer = null;
/** Opens Spotify's sign-in page in the browser and waits for it to send you back to Pane. */
function connectSpotify(clientId) {
  clientId = String(clientId || '').trim();
  if (!/^[0-9a-zA-Z]{16,64}$/.test(clientId)) return Promise.resolve({ ok: false, error: 'That doesn’t look like a Client ID.' });
  authServer?.close();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); authServer?.close(); authServer = null; resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, error: 'Timed out waiting for Spotify.' }), 5 * 60 * 1000);
    authServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Pane</title><body style="font:600 17px ui-rounded,system-ui;background:#E4ECE3;color:#1E2B27;display:grid;place-items:center;height:90vh"><p>${msg}</p>`;
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Spotify didn’t connect. You can close this tab and try again in Pane.'));
        finish({ ok: false, error: url.searchParams.get('error') === 'access_denied' ? 'Spotify access was declined.' : 'Spotify didn’t connect.' });
        return;
      }
      try {
        const r = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error_description || j.error || r.status);
        saveTokens({ clientId, access: j.access_token, refresh: j.refresh_token, scope: j.scope || SCOPES, expires: Date.now() + j.expires_in * 1000 - 30000 });
        const me = await api('/me').catch(() => null);
        if (me) saveTokens({ ...tokens, name: me.display_name || me.id });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page('Spotify is linked to Pane. You can close this tab.'));
        finish({ ok: true, ...spotifyAccount() });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(page('Spotify didn’t connect. You can close this tab and try again in Pane.'));
        finish({ ok: false, error: `Spotify said: ${err.message}` });
      }
    });
    authServer.on('error', () => finish({ ok: false, error: `Port ${SPOTIFY_PORT} is busy. Close what's using it and try again.` }));
    authServer.listen(SPOTIFY_PORT, '127.0.0.1', () => {
      const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', code_challenge: challenge, state, scope: SCOPES });
      shell.openExternal(`https://accounts.spotify.com/authorize?${q}`);
    });
  });
}

async function accessToken() {
  const t = loadTokens();
  if (!t?.refresh) return null;
  if (t.access && Date.now() < t.expires) return t.access;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'invalid_grant') disconnectSpotify(); // revoked: link again from settings
    throw new Error(j.error_description || `token ${r.status}`);
  }
  saveTokens({ ...t, access: j.access_token, refresh: j.refresh_token || t.refresh, scope: j.scope || t.scope, expires: Date.now() + j.expires_in * 1000 - 30000 });
  return tokens.access;
}
async function api(p) {
  const token = await accessToken();
  if (!token) throw new Error('not linked');
  const url = p.startsWith('https://') ? p : `https://api.spotify.com/v1${p}`;
  if (!url.startsWith('https://api.spotify.com/')) throw new Error('bad url');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 204) return null;
  if (!r.ok) throw Object.assign(new Error(`Spotify ${r.status} for ${p}`), { status: r.status });
  return r.json();
}

/** A change through the Web API (PUT / POST). Throws with Spotify's reason when it says no. */
async function apiSend(method, p, body) {
  const t = loadTokens();
  if (t?.scope && !t.scope.split(' ').includes('user-modify-playback-state')) throw new Error('linked without playback permission');
  const token = await accessToken();
  if (!token) throw new Error('not linked');
  const url = `https://api.spotify.com/v1${p}`;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) return true;
  const j = await r.json().catch(() => ({}));
  throw Object.assign(new Error(`Spotify ${r.status}: ${j.error?.reason || j.error?.message || 'refused'}`), { status: r.status });
}

const fmt = (t, images) => t && {
  title: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', ') || t.show?.name || '',
  art: pickImage(t.album?.images || t.images || images),
  uri: t.uri,
};
function pickImage(list) {
  if (!list?.length) return null;
  const sorted = [...list].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= 60) || sorted[sorted.length - 1]).url;
}

// A playlist's or album's songs, kept for a few minutes (up to 1,000).
let spotifyCtx = { uri: null, items: null, at: 0 };
async function contextTracks(ctx) {
  if (spotifyCtx.uri === ctx.uri && Date.now() - spotifyCtx.at < 5 * 60 * 1000) return spotifyCtx.items;
  const id = ctx.uri.split(':').pop();
  let items = [];
  if (ctx.type === 'album') {
    const album = await api(`/albums/${id}`);
    let page = album.tracks;
    while (page) {
      items.push(...page.items.map((t) => fmt(t, album.images)));
      page = page.next && items.length < 1000 ? await api(page.next) : null;
    }
  } else if (ctx.type === 'playlist') {
    let page = await api(`/playlists/${id}/items?limit=100`).catch(() => api(`/playlists/${id}/tracks?limit=100`));
    while (page) {
      items.push(...page.items.map((x) => fmt(x.item || x.track)).filter((t) => t?.uri));
      page = page.next && items.length < 1000 ? await api(page.next) : null;
    }
  } else {
    return null;
  }
  spotifyCtx = { uri: ctx.uri, items, at: Date.now() };
  return items;
}

/**
 * Spotify's whole list, as it will really play.
 *  Coming: Spotify's own queue first (songs you queued, the playlist's next songs and, once the
 *  playlist runs out without repeat, Spotify's suggestions). Past the queue, the rest of the
 *  playlist or album, around again from the top when it repeats.
 *  Played: in order, the playlist's earlier songs (around from the end when it repeats); shuffled
 *  or with no playlist, what you recently played.
 * Each song says how to reach it: `skip` (that many skips through the queue), `ctx` (play it within
 * the playlist) or neither (play it on its own). `tag` marks queued songs and suggestions.
 */
async function spotifyList(np) {
  if (!spotifyAccount().connected || !np.track) return null;
  const [player, queue] = await Promise.all([
    api('/me/player').catch(() => null),
    api('/me/player/queue').catch(() => null),
  ]);
  const ctx = player?.context;
  spotifyNowCtx = ctx?.uri || null;
  const shuffle = player?.shuffle_state ?? !!np.shuffle;
  const repeat = player?.repeat_state || np.repeat || 'off';
  const C = ctx?.uri && (ctx.type === 'playlist' || ctx.type === 'album') ? await contextTracks(ctx).catch(() => null) : null;
  const N = C?.length || 0;
  const ci = C ? C.findIndex((t) => t.uri === np.track.id) : -1;
  const ordered = C && ci >= 0 && !shuffle; // the playlist's order is the order things play in
  const loops = ordered && repeat === 'context' && N > 1;
  const current = fmt(queue?.currently_playing || player?.item) || { title: np.track.title, artist: np.track.artist, art: np.track.art, uri: np.track.id };

  // Coming up: the queue, in Spotify's order. Walk the playlist alongside it to tell its songs
  // from ones you queued, and from Spotify's suggestions once the playlist has ended.
  const up = [];
  let p = ci; // where in the playlist the queue has reached
  let ended = ordered && !loops && ci === N - 1;
  (queue?.queue || []).forEach((t, j) => {
    const item = fmt(t);
    if (!item?.uri) return;
    item.skip = j + 1;
    if (ordered && !ended) {
      const nextAt = loops ? (p + 1) % N : p + 1;
      if (nextAt < N && C[nextAt].uri === item.uri) {
        p = nextAt;
        item.ctx = true;
        if (!loops && p === N - 1) ended = true;
      } else item.tag = 'Queued';
    } else if (ended) item.tag = 'Suggested';
    else if (C && !C.some((x) => x.uri === item.uri)) item.tag = shuffle ? 'Queued' : 'Suggested';
    up.push(item);
  });
  // Past what the queue shows: the rest of the playlist, around again if it repeats.
  if (ordered && !ended) {
    const shown = new Set();
    for (let k = p + 1; ; k++) {
      if (!loops && k >= N) break;
      const at = k % N;
      if (at === ci || shown.has(at) || up.length >= 1000) break;
      shown.add(at);
      up.push({ ...C[at], ctx: true });
    }
  }

  // Played before: the playlist backwards from here (around from its end if it repeats), else history.
  let back = [];
  if (ordered) {
    for (let k = ci - 1; k > ci - N; k--) {
      if (!loops && k < 0) break;
      back.push({ ...C[((k % N) + N) % N], ctx: true });
    }
  } else {
    const recent = await api('/me/player/recently-played?limit=50').catch(() => null);
    back = (recent?.items || []).map((x) => fmt(x.track)).filter(Boolean);
    if (back.length && back[0].uri === np.track.id) back.shift(); // the song that's on now
  }
  // ordered: every song here is exactly its distance away by next / previous.
  return { source: 'spotify', context: ctx?.uri || null, items: [...back.reverse(), current, ...up], index: back.length, loop: loops, ordered };
}

module.exports = { playlists, playPlaylist, keepFront, frontBundle, giveFront, isSelf, onSelfFront, APPS, refresh, snapshot, onChange, act, playAt, connectSpotify, disconnectSpotify, spotifyAccount, REDIRECT };
