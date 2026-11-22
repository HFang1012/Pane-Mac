const { app, BrowserWindow, Menu, ipcMain, screen, systemPreferences, shell, globalShortcut, desktopCapturer, clipboard, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const Wheel = require('./wheel.js'); // same geometry the wheel is drawn with, for hit-testing
const Tools = require('./tools.js'); // Pane's tools and Away's moods
const Spin = require('./spin.js'); // Spin's music wheel: same geometry for drawing and hit-testing
const Music = require('./music.js'); // Spin's link to Spotify, Music or the media keys
const Updater = require('./updater.js'); // checks GitHub for a newer Pane and offers to install it
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Keep Chromium off the Keychain. It keeps its own "Pane Safe Storage" key there for cookies, and since Pane
// is signed locally each build looks like a stranger to it, so macOS asked for your password at every launch.
// Pane keeps nothing secret in cookies, so a stand-in key is fine.
app.commandLine.appendSwitch('use-mock-keychain');
// A separate settings folder, for running a working copy beside the installed Pane.
if (process.env.PANE_USER_DATA) app.setPath('userData', process.env.PANE_USER_DATA);

// ---------- persistence ----------
// Ring tools. Undo and redo are half-size and start out side by side, so together they fill one slot.
// Letting go in the middle of the wheel cancels.
const TOOL_IDS = ['pencil', 'eraser', 'clear', 'undo', 'redo', 'toggle'];
const DEFAULTS = {
  hotkey: { codes: [UiohookKey.Alt], symbol: '⌥', name: 'Left Option', side: 'left' },
  // 'hold': hold the wheel key. 'double': tap it, then tap again and keep holding.
  wheelMode: 'hold',
  // Held while a tool is in hand, it puts the pen down without clicking.
  drawKey: { codes: [UiohookKey.Ctrl], symbol: '⌃', name: 'Left Control', side: 'left' },
  tools: TOOL_IDS.map((id) => ({ id, on: true })),
  pencilColor: '#E5484D',
  pencilSize: 4,
  eraserSize: 28,
  wheelSize: 76,
  openAtLogin: false,
  enabled: true, // the on/off button: off means Scrawl ignores its keys and hides drawings (kept, not deleted)
  page: 'scrawl', // which tool the settings window shows
  away: {
    // A shortcut, not a held key: it toggles the Away screen. ⌃⌘A stays clear of Scrawl's ⌥ and of most apps.
    // Or double-tap a key (right ⇧ to start) instead.
    mode: 'shortcut', // 'shortcut' | 'double'
    keys: { accelerator: 'Control+Command+A', symbols: ['⌃', '⌘', 'A'], name: 'Control Command A' },
    key: { codes: [UiohookKey.ShiftRight], symbol: '⇧', name: 'Right Shift', side: 'right' },
    message: Tools.DEFAULT_MESSAGE,
    mood: 'dusk',
    showTime: true,
    hidePointer: true,
    enabled: true,
  },
  spin: {
    // Held like Scrawl's wheel key. The right ⌘ alone, so it stays clear of ⌘-shortcuts made with the left one.
    key: { codes: [UiohookKey.MetaRight], symbol: '⌘', name: 'Right Command', side: 'right' },
    mode: 'hold', // 'hold' | 'double' (tap, then tap again and keep holding)
    app: 'spotify', // 'spotify' | 'music' | 'other' (any player, through the media keys)
    count: 5, // songs shown each way
    size: 76, // the music wheel's own size, apart from Scrawl's (one of WHEEL_SIZES)
    // The music wheel's slices, top first and clockwise. Off ones keep their place for when they come back.
    wheel: [{ id: 'play', on: true }, { id: 'next', on: true }, { id: 'volume', on: true }, { id: 'prev', on: true }, { id: 'lists', on: true }],
    enabled: true,
  },
  jot: {
    // Double-tap a key (left ⌃ to start) or press a shortcut, and a note opens at the pointer.
    mode: 'double', // 'double' | 'shortcut'
    key: { codes: [UiohookKey.Ctrl], symbol: '⌃', name: 'Left Control', side: 'left' },
    keys: { accelerator: 'Control+Command+J', symbols: ['⌃', '⌘', 'J'], name: 'Control Command J' },
    snooze: 10, // minutes
    last: 15, // the timer the last note was sent with: the next one starts there
    sound: true,
    enabled: true,
  },
  tweak: {
    // Double-tap right ⌥ and the pointer picks out files on the desktop and in Finder. Click one to edit it.
    // Or press a shortcut instead.
    mode: 'double', // 'double' | 'shortcut'
    key: { codes: [UiohookKey.AltRight], symbol: '⌥', name: 'Right Option', side: 'right' },
    keys: { accelerator: 'Control+Command+E', symbols: ['⌃', '⌘', 'E'], name: 'Control Command E' },
    copy: false, // save as a copy, keeping the original, unless you say otherwise in the editor
    trash: true, // the version you replaced goes to the Trash instead of being gone for good
    enabled: true,
  },
};
const JOT_SNOOZES = [5, 10, 15, 30, 60];
const SPIN_COUNTS = [3, 4, 5, 6];
const WHEEL_SIZES = [60, 76, 96]; // small, medium, large (outer radius, px)
// Every slice once, in the saved order (new ones go on the end), and at least one on.
function cleanSpinWheel(list) {
  const known = (Array.isArray(list) ? list : []).filter((x, i, a) => Spin.ALL_SLICES.includes(x?.id) && a.findIndex((y) => y?.id === x.id) === i)
    .map((x) => ({ id: x.id, on: x.on !== false }));
  const out = [...known, ...DEFAULTS.spin.wheel.filter((d) => !known.some((x) => x.id === d.id))];
  if (!out.some((x) => x.on)) out[0].on = true;
  return out;
}
const spinLayout = () => settings.spin.wheel.filter((x) => x.on).map((x) => x.id);

const file = (name) => path.join(app.getPath('userData'), name);

// Scrawl used to be the whole app. Its settings and drawings move into Pane the first time Pane opens.
function migrateFromScrawl() {
  const old = path.join(app.getPath('appData'), 'Scrawl');
  if (fs.existsSync(file('settings.json')) || !fs.existsSync(path.join(old, 'settings.json'))) return;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  for (const name of ['settings.json', 'drawings.json']) {
    try { fs.copyFileSync(path.join(old, name), file(name)); } catch {}
  }
}
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJSON(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(data));
}

let settings;
let drawings; // { [displayId]: stroke[] }
let saveTimer = null;
function saveDrawingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJSON('drawings.json', drawings), 400);
}

// ---------- runtime state ----------
let activeTool = null; // 'pencil' | 'eraser' | 'picker' (taking a color from the screen) | null
let visible = true;
let holding = false;
let binding = false; // false, or which key is being chosen: 'hotkey' | 'drawKey'
let pen = null; // { displayId, by: 'key' | 'mouse' } while the draw key or the mouse button holds the pen down
let quitting = false;
const menu = { open: false, x: 0, y: 0, displayId: null, hover: -1, items: [] };
// Spin's wheel. offUp / offBack scroll the coming and past songs; vol0 is the volume it opened at.
const spin = { open: false, x: 0, y: 0, displayId: null, hover: -1, offUp: 0, offBack: 0, offPl: 0, offPl0: 0, pl: null, vol0: null, vol: null, scroll: null };
const overlays = new Map(); // displayId -> BrowserWindow
let settingsWin = null;

const publicState = () => ({ activeTool, visible, settings });
function sendOverlays(channel, payload) {
  for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}
function broadcast() {
  // Show any layer first, then send the new state, so fade-ins play on a window that's on screen.
  syncOverlays();
  sendOverlays('state', publicState());
  ensurePoll();
}

// ---------- overlay windows (one per display) ----------
// Above full-screen apps (and the menu bar) while in use; the layer is hidden the rest of the time.
const OVERLAY_LEVEL = 'screen-saver';

// Rebuild the layers only when screens really change (added, removed, moved, resized, rescaled).
// Switching Spaces or into a full-screen app changes each screen's *work area* (the menu bar and Dock
// hide), and rebuilding then used to tear the layers down mid-use.
const displaysKey = () => screen.getAllDisplays()
  .map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`)
  .sort().join('|');
let builtFor = '';
function refreshOverlays() {
  if (displaysKey() !== builtFor) createOverlays();
}

// Make sure a layer covers its whole screen, sits above full-screen apps, and joins every Space.
// Done each time it appears, because macOS can move or re-level a hidden panel.
function pinOverlay(w) {
  const d = screen.getAllDisplays().find((x) => String(x.id) === w.displayId);
  if (d) {
    const b = w.getBounds();
    if (b.x !== d.bounds.x || b.y !== d.bounds.y || b.width !== d.bounds.width || b.height !== d.bounds.height) w.setBounds(d.bounds);
  }
  w.setAlwaysOnTop(true, OVERLAY_LEVEL);
  joinSpaces(w);
}

// Every layer joins every Space, so drawings follow you around.
// Layers are panels, which can sit over full-screen apps on their own. So skipTransformProcessType, always:
// Electron's full-screen trick briefly turns Pane into a background app and back, and that flip used to
// drop Pane's settings window on top of whatever full-screen app you were in, instead of on a desktop.
function joinSpaces(w) {
  if (!w.isDestroyed()) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

// A screen point in a layer's own coordinates, from the window's real frame (not the display's),
// so the wheel and pen land under the cursor even if macOS nudged the window.
function toLocal(id, p) {
  const w = overlays.get(id);
  const b = w && !w.isDestroyed()
    ? w.getBounds()
    : (screen.getAllDisplays().find((d) => String(d.id) === id)?.bounds ?? { x: 0, y: 0 });
  return { x: p.x - b.x, y: p.y - b.y };
}

function createOverlays() {
  builtFor = displaysKey();
  for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy();
  overlays.clear();
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      acceptFirstMouse: true,
      type: 'panel',
      show: false,
      // The layer stays hidden most of the time; keep its page awake so the wheel appears instantly.
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    w.displayId = String(d.id);
    w.setIgnoreMouseEvents(true); // from the very start: an idle layer must never catch a click
    // Mark the layer as a background window, not one of Pane's real windows. Without this, a layer on
    // every Space (full-screen apps included) makes macOS treat Pane as present wherever you swipe: with
    // Pane in front, swiping into a full-screen app bounced you straight back to Pane's window.
    w.setHiddenInMissionControl(true);
    w.setAlwaysOnTop(true, OVERLAY_LEVEL);
    joinSpaces(w);
    w.loadFile(path.join(__dirname, 'overlay.html'), { query: { id: String(d.id) } });
    w.once('ready-to-show', () => { pinOverlay(w); w.ready = true; syncOverlays(); });
    overlays.set(String(d.id), w);
  }
}

// While Scrawl is on, each display's drawing layer stays on screen all the time: fully transparent and
// letting every click through when idle, so you can't see or touch it. It must never be hidden, because
// macOS drops a hidden window's "join every Space" setting and brings it back on Scrawl's own Space,
// not the one you're on. Turning Scrawl off is the only time the layers leave the screen.
function overlayNeeded() {
  return settings.enabled || settings.spin.enabled; // Spin's wheel opens on the same layers
}
function syncOverlays() {
  for (const [, w] of overlays) {
    if (w.isDestroyed() || !w.ready) continue;
    // Clicks pass straight through unless a pencil or eraser is in hand. On picking one up, let go and
    // take hold again, so macOS really hands the clicks to the layer rather than to the app beneath.
    const catching = !!activeTool;
    if (catching && !w.catching) w.setIgnoreMouseEvents(true);
    w.setIgnoreMouseEvents(!catching);
    w.catching = catching;
    if (overlayNeeded()) {
      clearTimeout(w.hideTimer);
      w.hideTimer = null;
      if (!w.isVisible()) {
        pinOverlay(w);
        w.showInactive();
        joinSpaces(w);
      }
    } else if (w.isVisible() && !w.hideTimer) {
      // Turned off: let the drawings fade out first, then take the layer away.
      w.hideTimer = setTimeout(() => {
        w.hideTimer = null;
        if (!w.isDestroyed() && !overlayNeeded()) w.hide();
      }, 720);
    }
  }
}

// ---------- cursor polling (only while the wheel is open or a tool is held) ----------
let poll = null;
let lastCursorKey = '';
function ensurePoll() {
  const need = menu.open || spin.open || !!activeTool;
  if (need && !poll) poll = setInterval(tick, 8);
  if (!need && poll) {
    clearInterval(poll); poll = null; lastCursorKey = '';
    sendOverlays('cursor', null);
  }
}
// -1 is the middle (cancel), n a slice, Wheel.COLOR_HOVER + i the pencil in Wheel.COLORS[i].
function hoverIndex(dx, dy) {
  return Wheel.hitTest(settings.wheelSize, menu.items, dx, dy, settings.pencilColor);
}
function tick() {
  const p = screen.getCursorScreenPoint();
  if (menu.open) {
    const h = hoverIndex(p.x - menu.x, p.y - menu.y);
    if (h !== menu.hover) {
      menu.hover = h;
      overlays.get(menu.displayId)?.webContents.send('menu:hover', h);
    }
  }
  if (spin.open) {
    const h = spinHit(p);
    if (h !== spin.hover) spinHover(h);
  }
  const d = screen.getDisplayNearestPoint(p);
  if (pen && pen.displayId !== String(d.id)) penUp(); // a stroke can't cross between screens
  const key = `${d.id}:${p.x}:${p.y}`;
  if (key === lastCursorKey) return;
  lastCursorKey = key;
  for (const [id, w] of overlays) {
    if (w.isDestroyed()) continue;
    w.webContents.send('cursor', id === String(d.id) ? toLocal(id, p) : null);
  }
}

// ---------- wheel ----------
function openMenu() {
  penUp();
  const items = settings.tools.filter((t) => t.on).map((t) => t.id);
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  Object.assign(menu, { open: true, x: p.x, y: p.y, displayId: String(d.id), hover: -1, items });
  syncOverlays(); // make sure the layer is up,
  const layer = overlays.get(menu.displayId);
  if (layer && !layer.isDestroyed()) pinOverlay(layer); // covering this screen, then measure the cursor on it
  overlays.get(menu.displayId)?.webContents.send('menu:open', { ...toLocal(menu.displayId, p), items, ...publicState() });
  ensurePoll();
}
function closeMenu(pick) {
  if (!menu.open) return;
  // Read the cursor at the moment of release so a quick flick still lands on the right slice.
  const p = screen.getCursorScreenPoint();
  const hover = hoverIndex(p.x - menu.x, p.y - menu.y);
  let choice = null; // letting go in the middle cancels
  if (pick && hover === Wheel.PICK_HOVER) choice = 'picker';
  else if (pick && hover >= Wheel.COLOR_HOVER) choice = { tool: 'pencil', color: Wheel.COLORS[hover - Wheel.COLOR_HOVER].hex };
  else if (pick && hover >= 0) choice = menu.items[hover];
  overlays.get(menu.displayId)?.webContents.send('menu:close', choice);
  menu.open = false;
  if (choice) applyTool(choice);
  else syncOverlays();
  ensurePoll();
}
function applyTool(id) {
  penUp();
  // A color from the ring beside the pencil: switch to it and pick up the pencil (never puts it down).
  if (id && typeof id === 'object') {
    settings = { ...settings, pencilColor: id.color };
    writeJSON('settings.json', settings);
    activeTool = 'pencil';
    visible = true;
    broadcast();
    settingsWin?.webContents.send('settings:changed', settings);
    return;
  }
  if (id === 'picker') {
    // Choosing the picker again while it's out puts it away, back to what you held before.
    if (activeTool === 'picker') { pickToken++; activeTool = pickFrom; broadcast(); }
    else startPick();
    return;
  }
  if (id === 'pencil' || id === 'eraser') {
    // Picking the tool you're already holding puts it down.
    activeTool = activeTool === id ? null : id;
    if (activeTool) visible = true;
  } else if (id === 'toggle') {
    activeTool = null;
    visible = !visible;
  } else if (id === 'clear') {
    activeTool = null;
    visible = true;
    if (Object.values(drawings).some((list) => list.length)) record({ type: 'clear', snapshot: drawings });
    drawings = {};
    writeJSON('drawings.json', drawings);
    sendOverlays('strokes:clear');
  } else if (id === 'undo' || id === 'redo') {
    // Keeps whatever tool you're holding, so you can undo and carry on drawing.
    step(id);
    return;
  }
  broadcast();
}

// ---------- color picker ----------
// Takes one color from the screen, then hands you the pencil in it. The screen is photographed once
// (after the wheel has shrunk away, so it isn't in the picture) and each layer samples its own photo,
// so the loupe beside the cursor is never in what it shows. Needs Screen Recording access.
let pickFrom = null; // the tool held before the picker, for putting it away again
let pickToken = 0; // a newer pick (or putting the picker away) cancels a photo still being taken
async function startPick() {
  pickFrom = activeTool;
  activeTool = 'picker'; // the layers catch clicks from now on, so nothing lands in the app beneath
  broadcast();
  const token = ++pickToken;
  const live = () => token === pickToken && activeTool === 'picker';
  await new Promise((r) => setTimeout(r, 260)); // the wheel's closing animation
  if (!live()) return;
  let shots = null;
  try { shots = await photographScreens(); } catch (err) { console.warn('Screen photo failed:', err.message); }
  if (!live()) return;
  const access = systemPreferences.getMediaAccessStatus('screen');
  if (access !== 'granted' || !shots?.size) {
    // Without access macOS hands back only the wallpaper, so don't pretend: say what's needed.
    activeTool = pickFrom;
    broadcast();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlays.get(String(d.id))?.webContents.send('pick:denied');
    if (access === 'denied') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return;
  }
  for (const [id, shot] of shots) overlays.get(id)?.webContents.send('pick:image', shot);
}
// One full-resolution photo per screen, as raw BGRA pixels (exact colors, no PNG round trip).
async function photographScreens() {
  const out = new Map();
  const bySize = new Map();
  for (const d of screen.getAllDisplays()) {
    const size = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    const key = `${size.width}x${size.height}`;
    if (!bySize.has(key)) bySize.set(key, { size, ids: [] });
    bySize.get(key).ids.push(String(d.id));
  }
  for (const { size, ids } of bySize.values()) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    for (const src of sources) {
      if (!ids.includes(String(src.display_id)) || src.thumbnail.isEmpty()) continue;
      const data = src.thumbnail.toBitmap();
      const { width, height } = src.thumbnail.getSize();
      const k = Math.sqrt(data.length / 4 / (width * height)) || 1; // getSize can be in points
      out.set(String(src.display_id), { width: Math.round(width * k), height: Math.round(height * k), data });
    }
  }
  return out;
}
function pickAt() {
  const p = screen.getCursorScreenPoint();
  const id = String(screen.getDisplayNearestPoint(p).id);
  overlays.get(id)?.webContents.send('pick:click', toLocal(id, p));
}
ipcMain.on('pick:color', (_e, hex) => {
  if (activeTool !== 'picker' || !/^#[0-9A-F]{6}$/.test(hex)) return;
  pickToken++;
  settings = { ...settings, pencilColor: hex };
  writeJSON('settings.json', settings);
  activeTool = 'pencil';
  visible = true;
  broadcast();
  settingsWin?.webContents.send('settings:changed', settings);
});

// ---------- undo / redo ----------
// Every pencil or eraser stroke, and Clear all, is one step. Kept in memory for this session.
const history = { undo: [], redo: [] };
function record(action) {
  history.undo.push(action);
  if (history.undo.length > 300) history.undo.shift();
  history.redo = [];
}
function step(dir) {
  const from = dir === 'undo' ? history.undo : history.redo;
  const to = dir === 'undo' ? history.redo : history.undo;
  const action = from.pop();
  if (!action) return;
  to.push(action);
  if (!visible) visible = true; // you should see what you're undoing
  if (action.type === 'stroke') {
    const list = (drawings[action.id] ||= []);
    if (dir === 'undo') {
      const i = list.lastIndexOf(action.stroke);
      if (i >= 0) list.splice(i, 1);
    } else {
      list.push(action.stroke);
    }
    syncOverlays();
    overlays.get(action.id)?.webContents.send(dir === 'undo' ? 'stroke:undo' : 'stroke:redo', action.stroke);
  } else if (action.type === 'clear') {
    if (dir === 'undo') {
      drawings = action.snapshot;
      syncOverlays();
      for (const [id, w] of overlays) w.webContents.send('strokes:restore', drawings[id] || []);
    } else {
      drawings = {};
      sendOverlays('strokes:clear');
    }
  }
  saveDrawingsSoon();
  broadcast();
}
function dropTool() {
  penUp();
  if (!activeTool) return;
  activeTool = null;
  broadcast();
}

// ---------- pen down: the draw key, or the mouse button ----------
// Both come from the global hook, not from the layer's own clicks. A layer that has been on screen a
// long time (across Spaces, full-screen apps, sleep) can stop getting clicks from macOS even though it
// asked for them, and then clicking drew nothing while the draw key still worked. The hook always sees both.
function penDown(by) {
  if (!activeTool || menu.open || pen) return;
  if (activeTool === 'picker') { pickAt(); return; } // a click (or the draw key) takes the color
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  pen = { displayId: String(d.id), by };
  overlays.get(pen.displayId)?.webContents.send('pen:down', toLocal(pen.displayId, p));
}
// With `by`, only lifts a pen that the same thing put down (letting go of ⌃ doesn't end a mouse stroke).
function penUp(by) {
  if (!pen || (by && pen.by !== by)) return;
  overlays.get(pen.displayId)?.webContents.send('pen:up');
  pen = null;
}

// ---------- key binding ----------
const keyName = {};
for (const [k, v] of Object.entries(UiohookKey)) if (!(v in keyName)) keyName[v] = k;
const MODIFIERS = { Alt: ['⌥', 'Option'], Ctrl: ['⌃', 'Control'], Meta: ['⌘', 'Command'], Shift: ['⇧', 'Shift'] };
const SYMBOLS = { CapsLock: '⇪', Space: '␣', Tab: '⇥', Backquote: '`', Backspace: '⌫', Enter: '↩' };
// A modifier counts only on the side it was pressed: left ⌥ and right ⌥ are different keys.
function keyInfo(code) {
  const n = keyName[code] || `Key ${code}`;
  const base = n.replace(/Right$/, '');
  if (MODIFIERS[base]) {
    const side = n.endsWith('Right') ? 'right' : 'left';
    return { codes: [code], symbol: MODIFIERS[base][0], name: `${side === 'right' ? 'Right' : 'Left'} ${MODIFIERS[base][1]}`, side };
  }
  const nice = n === 'CapsLock' ? 'Caps Lock' : n;
  return { codes: [code], symbol: SYMBOLS[n] || (n.length <= 3 ? n : n[0]), name: nice };
}

// ---------- held keys: one key, or several held together ----------
// Each held key (Scrawl's wheel key and draw key, Spin's key) is a combo of one or more keys. Each key
// lists the codes that count for it: both sides of a modifier, or only one side for Spin's. `codes`,
// `symbol` and `name` describe the whole combo.
function combo(keys) {
  const c = { keys, codes: [...new Set(keys.flatMap((k) => k.codes))], symbol: keys.map((k) => k.symbol).join(''), name: keys.map((k) => k.name).join(' + ') };
  if (keys.length === 1 && keys[0].side) c.side = keys[0].side;
  return c;
}
// Settings saved before combos had a single key's fields at the top, and a modifier then counted on
// both sides. Now every modifier has a side: an old both-sides key becomes its left one.
function asCombo(k) {
  const keys = k?.keys?.length ? k.keys : [{ codes: k.codes, symbol: k.symbol, name: k.name, ...(k.side ? { side: k.side } : {}) }];
  return combo(keys.map((key) => (key.codes.length > 1 && MOD_CODES.has(key.codes[0]) ? keyInfo(key.codes[0]) : key)));
}
const KEY_LABEL = { hotkey: 'wheel key', drawKey: 'draw key', spinKey: 'Spin key', jotKey: 'Jot key', tweakKey: 'Tweak key', awayKey: 'Away key' };
// Every held key Pane listens for, by name. Spin's, Jot's, Tweak's and Away's live inside their own settings.
const OWN_KEY = { spinKey: 'spin', jotKey: 'jot', tweakKey: 'tweak', awayKey: 'away' };
const keyOf = (which) => (OWN_KEY[which] ? settings[OWN_KEY[which]].key : settings[which]);
function setKey(which, info) {
  if (OWN_KEY[which]) settings = { ...settings, [OWN_KEY[which]]: { ...settings[OWN_KEY[which]], key: info } };
  else settings = { ...settings, [which]: info };
}
// A double-tap key (Jot's, Tweak's) may be the same key as Scrawl's draw key (left ⌃ for Jot, to start): the
// draw key only draws with a tool in hand, and neither opens then. Every other pair must differ.
const mayShare = (a, b) => ['drawKey,jotKey', 'drawKey,tweakKey'].includes([a, b].sort().join());
// Keys that are tapped twice: Jot's, Tweak's and Away's always, and Scrawl's wheel key and Spin's key when
// they're set to double-tap and hold. A tapped key is one modifier on its own.
const tapped = (which) => ['jotKey', 'tweakKey', 'awayKey'].includes(which) ||
  (which === 'hotkey' && settings.wheelMode === 'double') || (which === 'spinKey' && settings.spin.mode === 'double');
const oneModifier = (k) => k.keys.length === 1 && MOD_CODES.has(k.keys[0].codes[0]);
// Switching a held key over to double-tap: keep one of its modifiers if it has one, else find a free one.
function fitTapKey(which) {
  const k = keyOf(which);
  if (!tapped(which) || oneModifier(k)) return;
  const clash = (c) => Object.keys(KEY_LABEL).some((o) => o !== which && !mayShare(o, which) && sameCombo(c, keyOf(o)));
  const mine = k.keys.filter((x) => MOD_CODES.has(x.codes[0])).map((x) => x.codes[0]);
  const all = [UiohookKey.Alt, UiohookKey.AltRight, UiohookKey.Ctrl, UiohookKey.CtrlRight, UiohookKey.Shift, UiohookKey.ShiftRight, UiohookKey.Meta, UiohookKey.MetaRight];
  const pick = [...mine, ...all].map((c) => combo([keyInfo(c)])).find((c) => !clash(c));
  if (pick) setKey(which, pick);
}

// What's held right now. Modifiers follow the event's own flags, which macOS keeps accurate. Other keys
// repeat their key-down while held, so one not seen for a second counts as let go (macOS sometimes drops
// key-ups, and a stuck entry must never block a wheel for good).
const down = new Map(); // keycode -> last seen
const MOD_FLAGS = [
  ['altKey', [UiohookKey.Alt, UiohookKey.AltRight]],
  ['ctrlKey', [UiohookKey.Ctrl, UiohookKey.CtrlRight]],
  ['metaKey', [UiohookKey.Meta, UiohookKey.MetaRight]],
  ['shiftKey', [UiohookKey.Shift, UiohookKey.ShiftRight]],
];
const MOD_CODES = new Set(MOD_FLAGS.flatMap(([, codes]) => codes));
function noteKey(e, isDown) {
  if (isDown) down.set(e.keycode, Date.now());
  else down.delete(e.keycode);
  for (const [flag, codes] of MOD_FLAGS) {
    if (!e[flag]) for (const c of codes) if (c !== e.keycode) down.delete(c);
  }
  const now = Date.now();
  for (const [c, seen] of down) if (!MOD_CODES.has(c) && now - seen > 1000) down.delete(c);
}
const inCombo = (ch, code) => ch.codes.includes(code);
const comboHeld = (ch) => ch.keys.every((k) => k.codes.some((c) => down.has(c)));
// Anything held that isn't part of this combo means you're pressing a shortcut, not the combo.
const othersHeld = (ch) => [...down.keys()].some((c) => !ch.codes.includes(c));

// Two combos clash when they're the same keys (a key counts as the same if any of its codes match).
const sameCombo = (a, b) => a.keys.length === b.keys.length && a.keys.every((k) => b.keys.some((j) => j.codes.some((c) => k.codes.includes(c))));

// Choosing a combo: hold the keys together; letting go of any of them sets the combo. Esc on its own cancels.
let bindKeys = [];
function bindKeyDown(e) {
  if (e.keycode === UiohookKey.Escape && !bindKeys.length) { finishBind(true); return; }
  const info = keyInfo(e.keycode);
  if (bindKeys.length >= 4 || bindKeys.some((k) => k.codes.some((c) => info.codes.includes(c)))) return;
  bindKeys.push(info);
  settingsWin?.webContents.send('bind:progress', { which: binding, keys: bindKeys });
}
function bindKeyUp(e) {
  if (bindKeys.some((k) => k.codes.includes(e.keycode))) finishBind(false);
}
function finishBind(cancel) {
  const which = binding;
  const keys = bindKeys;
  binding = false;
  bindKeys = [];
  let error = null;
  if (!cancel && keys.length) {
    const next = combo(keys);
    const other = Object.keys(KEY_LABEL).find((k) => k !== which && !mayShare(k, which) && sameCombo(next, keyOf(k)));
    if (other) error = `${next.name} ${keys.length > 1 ? 'are' : 'is'} already your ${KEY_LABEL[other]}. Pick different keys.`;
    // Double-tapping a letter would happen all the time while typing ("ee"), so Jot takes one modifier.
    else if (tapped(which) && !oneModifier(next)) error = 'Double-tap works with one of ⌃, ⌥, ⇧ or ⌘. Pick just one.';
    else {
      setKey(which, next);
      writeJSON('settings.json', settings);
    }
  }
  settingsWin?.webContents.send('bind:done', { settings, which, error });
}

// ---------- global input ----------
// A wheel opens only when its whole combo is held and nothing else. If anything else is already held
// (⌃, ⌘, ⇧, a letter…), you're pressing a shortcut, so the wheel stays shut until its keys are let go.
let hotkeyBlocked = false; // the wheel key went down mid-shortcut: ignore it until it's let go

// A combo that's part of a longer one (⌥ for one tool, ⌥⇧ for another) waits a moment before it acts,
// so pressing the longer one quickly never sets off the shorter one first. Others act at once.
const COMBO_WAIT = 110;
const coversKeys = (big, small) => big.keys.length > small.keys.length &&
  small.keys.every((k) => big.keys.some((j) => j.codes.some((c) => k.codes.includes(c))));
const partOfLonger = (which) => Object.keys(KEY_LABEL).some((k) => k !== which && coversKeys(keyOf(k), keyOf(which)));
let wheelWait = null, drawWait = null;
function clearWaits(e, keyUp) {
  // Another key turns it into a different combo; letting go of one of its keys means it was a tap.
  const drop = (t, ch) => (t && (keyUp ? inCombo(ch, e.keycode) : !inCombo(ch, e.keycode)) ? (clearTimeout(t), null) : t);
  wheelWait = drop(wheelWait, settings.hotkey);
  drawWait = drop(drawWait, settings.drawKey);
}
function openWheelSoon() {
  if (!partOfLonger('hotkey')) { holding = true; openMenu(); return; }
  clearTimeout(wheelWait);
  wheelWait = setTimeout(() => {
    wheelWait = null;
    if (menu.open || spin.open || spinTimer || !comboHeld(settings.hotkey) || othersHeld(settings.hotkey)) return;
    holding = true;
    openMenu();
  }, COMBO_WAIT);
}
function penDownSoon() {
  if (!partOfLonger('drawKey')) { penDown('key'); return; }
  clearTimeout(drawWait);
  drawWait = setTimeout(() => {
    drawWait = null;
    if (!menu.open && comboHeld(settings.drawKey)) penDown('key');
  }, COMBO_WAIT);
}

const debug = process.env.PANE_DEBUG ? (...a) => console.log('[pane]', ...a) : () => {};
uIOhook.on('keydown', (e) => {
  noteKey(e, true);
  if (binding) { bindKeyDown(e); return; }
  if (target && e.keycode === UiohookKey.Escape) { endTarget(); return; } // Esc puts Tweak's pointer away
  for (const t of tappers()) t.feed(e, true);
  clearWaits(e, false);
  if (away || awayBinding) return; // the Away screen is up (or its keys are being chosen): Scrawl sits still
  if (spinKeyDown(e)) return; // Spin's key, or any key while Spin's wheel is up or about to open
  if (!settings.enabled) return; // turned off: every key goes untouched to your apps
  // ⌘Z / ⌘⇧Z undo and redo, but only with a pencil or eraser in hand (Scrawl can't stop the app
  // underneath from getting the keys too, and with a tool in hand you're drawing, not editing it).
  if (e.keycode === UiohookKey.Z && e.metaKey && activeTool && !menu.open) {
    step(e.shiftKey ? 'redo' : 'undo');
    return;
  }
  const wheel = settings.hotkey, draw = settings.drawKey;
  if (inCombo(draw, e.keycode) && comboHeld(draw) && !(inCombo(wheel, e.keycode) && comboHeld(wheel))) {
    if (menu.open) closeMenu(false);
    else penDownSoon();
    return;
  }
  if (inCombo(wheel, e.keycode)) {
    if (settings.wheelMode === 'double') return; // opened by its double-tap (wheelTap)
    // Open whenever the wheel isn't already up. Don't trust `holding` here: tapping fast can make macOS
    // drop a key-up, which used to leave `holding` stuck on and the wheel never opening again.
    if (menu.open) return;
    if (hotkeyBlocked) return; // still held from inside a shortcut
    if (!comboHeld(wheel)) return; // the rest of the combo is on its way
    if (othersHeld(wheel)) { hotkeyBlocked = true; return; }
    openWheelSoon();
    return;
  }
  if (inCombo(draw, e.keycode)) return; // part of the draw combo, the rest still to come
  // Any other key while the wheel is up means the user is typing a combo (⌥+letter) — get out of the way.
  if (menu.open) { closeMenu(false); return; }
  if (e.keycode === UiohookKey.Escape) dropTool();
});
uIOhook.on('keyup', (e) => {
  noteKey(e, false);
  if (binding) { bindKeyUp(e); return; }
  for (const t of tappers()) t.feed(e, false);
  clearWaits(e, true);
  if (inCombo(settings.hotkey, e.keycode)) hotkeyBlocked = false;
  if (inCombo(settings.spin.key, e.keycode)) { spinBlocked = false; spinKeyUp(); }
  if (away || awayBinding || !settings.enabled) return;
  if (inCombo(settings.drawKey, e.keycode)) penUp('key'); // letting go of any key in the combo lifts the pen
  if (!inCombo(settings.hotkey, e.keycode)) return;
  holding = false;
  closeMenu(true);
});
// Mouse button 1 is left, 2 is right. Right-click puts the tool down.
uIOhook.on('mousedown', (e) => {
  for (const t of tappers()) t.reset(); // ⌃-click is a click, not half a double-tap
  if (target) { targetClick(e.button); return; }
  if (spin.open || spinTimer) { cancelSpin(); return; } // a click while the music wheel is up: leave it be
  if (away || awayBinding || !settings.enabled || !activeTool || menu.open) return;
  if (e.button === 1) penDown('mouse');
  else if (e.button === 2) dropTool();
});
uIOhook.on('mouseup', (e) => {
  if (e.button === 1) penUp('mouse');
});


// ---------- Spin: the music wheel ----------
// Hold the Spin key and the wheel opens at the pointer, after a moment (so a quick ⌘-shortcut made with
// that key never flashes it). Slide to a slice or a song and let go. Letting go in the middle does nothing.
const SPIN_DELAY = 110;
let spinTimer = null;
let spinBlocked = false; // the Spin key went down mid-shortcut: ignore it until it's let go

function spinKeyDown(e) {
  const key = settings.spin.key;
  if (inCombo(key, e.keycode)) {
    if (!settings.spin.enabled || binding) return false;
    if (settings.spin.mode === 'double') return spin.open; // opened by its double-tap (spinTap)
    if (spin.open || spinTimer || spinBlocked) return true; // a held key repeats
    if (!comboHeld(key)) return false; // the rest of the combo is on its way (and Scrawl may want this key)
    if (othersHeld(key)) { spinBlocked = true; return true; }
    if (menu.open) closeMenu(false);
    Music.refresh(settings.spin.app); // start looking now; the wheel opens with what's known
    spinTimer = setTimeout(() => { spinTimer = null; openSpin(); }, SPIN_DELAY);
    return true;
  }
  // Another key: a shortcut, or a longer combo (maybe Scrawl's). Get out of the way and let it through.
  if (spinTimer || spin.open) cancelSpin();
  return false;
}
function spinKeyUp() {
  if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; return; } // a tap, not a hold
  if (!spin.open) return;
  closeSpin(true);
}
// Double-tap and hold: tap the Spin key, then press it again and keep holding. Letting go picks, as above.
const spinTap = doubleTap({
  key: () => settings.spin.key,
  on: () => settings.spin.enabled && settings.spin.mode === 'double',
  hold: () => {
    if (away || awayBinding || binding || spin.open || target) return;
    if (menu.open) closeMenu(false);
    Music.refresh(settings.spin.app);
    openSpin();
  },
});
// Scrawl's wheel the same way, when it's set to double-tap and hold.
const wheelTap = doubleTap({
  key: () => settings.hotkey,
  on: () => settings.enabled && settings.wheelMode === 'double',
  hold: () => {
    if (away || awayBinding || binding || menu.open || spin.open || spinTimer || target) return;
    holding = true;
    openMenu();
  },
});
// Every double-tap Pane listens for. Jot's, Tweak's and Away's are made further down.
const tappers = () => [jotTapper, tweakTap, awayTap, spinTap, wheelTap];

function cancelSpin() {
  if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
  closeSpin(false);
}

// The songs the wheel shows each way, from the app's list and how far you've scrolled.
// Your playlists as records: a window of `count` of them, from offPl.
function plView() {
  const n = settings.spin.count, P = spin.pl;
  const items = P?.items || [];
  const pl = items.slice(spin.offPl, spin.offPl + n).map((p, k) => ({ title: p.name, art: p.art, id: p.id, count: p.count ?? null, at: spin.offPl + k }));
  const note = !P ? 'loading' : P.error ? P.error : P.unsupported ? 'unsupported' : P.needsLink ? 'link' : P.running === false ? 'closed' : !items.length ? 'none' : null;
  return {
    pl, plMore: spin.offPl + n < items.length, plLess: spin.offPl > 0, plTotal: items.length,
    plCurrent: P?.current ?? null, plName: items.find((p) => p.id === P?.current)?.name || null, plNote: note,
  };
}
function spinView() {
  const L = Music.snapshot().list;
  const n = settings.spin.count;
  if (!L) return { up: [], back: [], upMore: false, upLess: false, backMore: false, backLess: false, total: 0, index: -1, offUp: 0, offBack: 0, ...plView() };
  const i = L.index;
  const up = [], back = [];
  for (let k = 0; k < n; k++) {
    const u = i + 1 + spin.offUp + k;
    if (u < L.items.length) up.push({ ...L.items[u], at: u });
    const b = i - 1 - spin.offBack - k;
    if (b >= 0) back.push({ ...L.items[b], at: b });
  }
  return {
    up, back,
    upMore: i + 1 + spin.offUp + n < L.items.length, upLess: spin.offUp > 0,
    backMore: i - 1 - spin.offBack - n >= 0, backLess: spin.offBack > 0,
    total: L.items.length, index: i, offUp: spin.offUp, offBack: spin.offBack, source: L.source, name: L.name || null,
    ...plView(),
  };
}
function spinCtx(view = spinView()) {
  return {
    prev: spin.hover, layout: spinLayout(), up: view.up.length, back: view.back.length, pl: view.pl.length,
    upMore: view.upMore, upLess: view.upLess, backMore: view.backMore, backLess: view.backLess, plMore: view.plMore, plLess: view.plLess,
  };
}
function spinHit(p) {
  return Spin.hitTest(settings.spin.size, settings.spin.count, p.x - spin.x, p.y - spin.y, spinCtx());
}
const spinLayer = () => overlays.get(spin.displayId)?.webContents;
function spinPayload() {
  const snap = Music.snapshot();
  return { np: snap.np, error: snap.error, app: settings.spin.app, linked: Music.spotifyAccount().connected, view: spinView(), volume: spin.vol ?? snap.np?.volume ?? null, layout: spinLayout() };
}

function openSpin() {
  if (spin.open || !settings.spin.enabled) return;
  penUp();
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  const np = Music.snapshot().np;
  Object.assign(spin, { open: true, x: p.x, y: p.y, displayId: String(d.id), hover: -1, offUp: 0, offBack: 0, offPl: 0, offPl0: 0, pl: null, vol0: np?.volume ?? null, vol: null });
  if (spinLayout().includes('lists')) loadSpinPlaylists();
  syncOverlays();
  const layer = overlays.get(spin.displayId);
  if (layer && !layer.isDestroyed()) pinOverlay(layer);
  spinLayer()?.send('spin:open', { ...toLocal(spin.displayId, p), size: settings.spin.size, count: settings.spin.count, ...spinPayload() });
  ensurePoll();
}
// The playlists come in after the wheel opens (kept a minute in music.js, so usually at once).
// The list starts around the one that's playing, so it's in view.
let spinOpenCount = 0;
function loadSpinPlaylists() {
  const opened = ++spinOpenCount;
  Music.playlists(settings.spin.app).then((P) => {
    if (!spin.open || opened !== spinOpenCount) return;
    spin.pl = P;
    const at = (P.items || []).findIndex((x) => x.id === P.current);
    spin.offPl = at >= settings.spin.count ? at - Math.floor(settings.spin.count / 2) : 0;
    clampSpinOffsets();
    spin.offPl0 = spin.offPl;
    spinLayer()?.send('spin:data', spinPayload());
  }).catch(() => {});
}
// Fresh news from the music app while the wheel is up: show it (keeping your place in the list).
Music.onChange(() => {
  if (!spin.open) return;
  if (spin.vol0 == null) spin.vol0 = Music.snapshot().np?.volume ?? null;
  clampSpinOffsets();
  spinLayer()?.send('spin:data', spinPayload());
});
function clampSpinOffsets() {
  const L = Music.snapshot().list;
  const n = settings.spin.count;
  spin.offPl = Math.max(0, Math.min(spin.offPl, (spin.pl?.items?.length || 0) - n));
  if (!L) { spin.offUp = spin.offBack = 0; return; }
  spin.offUp = Math.max(0, Math.min(spin.offUp, L.items.length - L.index - 1 - n));
  spin.offBack = Math.max(0, Math.min(spin.offBack, L.index - n));
}

function spinHover(h) {
  const prev = spin.hover;
  spin.hover = h;
  // Back in the middle: let go of everything, back to the song that's on and the volume you had.
  if (h === -1) {
    stopSpinScroll();
    const moved = spin.offUp || spin.offBack || spin.offPl !== spin.offPl0;
    spin.offUp = spin.offBack = 0;
    spin.offPl = spin.offPl0;
    if (spin.vol != null && spin.vol0 != null && spin.vol !== spin.vol0) Music.act(settings.spin.app, 'volume', spin.vol0);
    spin.vol = null;
    if (moved) spinLayer()?.send('spin:view', { view: spinView() });
  }
  if (Spin.isVol(h)) {
    spin.vol = h - Spin.VOL;
    Music.act(settings.spin.app, 'volume', spin.vol); // you hear it change as you slide
  }
  // Resting on an edge scrolls the list, faster the longer you stay.
  const edge = { [Spin.UP_MORE]: ['up', 1], [Spin.UP_LESS]: ['up', -1], [Spin.BACK_MORE]: ['back', 1], [Spin.BACK_LESS]: ['back', -1], [Spin.PL_MORE]: ['pl', 1], [Spin.PL_LESS]: ['pl', -1] }[h];
  if (edge) startSpinScroll(...edge);
  else if (spin.scroll && h !== prev) stopSpinScroll();
  spinLayer()?.send('spin:hover', { hover: h, volume: spin.vol ?? spin.vol0 });
}
function startSpinScroll(side, dir) {
  if (spin.scroll?.side === side && spin.scroll?.dir === dir) return;
  stopSpinScroll();
  const s = { side, dir, n: 0, timer: null };
  const tick = () => {
    const key = { up: 'offUp', back: 'offBack', pl: 'offPl' }[side];
    const before = spin[key];
    spin[key] += dir;
    clampSpinOffsets();
    if (spin[key] === before) { stopSpinScroll(); return; } // reached the end of the list
    s.n++;
    const view = spinView();
    spinLayer()?.send('spin:view', { view, shift: { side, dir } });
    // The edge may have gone (no more songs that way): look again at what's under the pointer.
    const h = spinHit(screen.getCursorScreenPoint());
    if (h !== spin.hover) { spinHover(h); if (spin.scroll !== s) return; }
    s.timer = setTimeout(tick, Math.max(60, 170 - s.n * 12));
  };
  s.timer = setTimeout(tick, 260);
  spin.scroll = s;
}
function stopSpinScroll() {
  if (spin.scroll) clearTimeout(spin.scroll.timer);
  spin.scroll = null;
}

function closeSpin(pick) {
  if (!spin.open) return;
  stopSpinScroll();
  const p = screen.getCursorScreenPoint();
  const h = spinHit(p);
  const view = spinView();
  const appId = settings.spin.app;
  let choice = null;
  if (pick) {
    if (h === Spin.SLICE.play) choice = { cmd: 'toggle' };
    else if (h === Spin.SLICE.next) choice = { cmd: 'next' };
    else if (h === Spin.SLICE.prev) choice = { cmd: 'prev' };
    else if (Spin.isVol(h)) choice = { cmd: 'volume', value: h - Spin.VOL };
    else if (Spin.isPl(h) && Spin.isBead(h)) {
      const item = view.pl[h - Spin.PL];
      if (item) choice = { cmd: 'playlist', id: item.id, side: 'pl', k: h - Spin.PL };
    } else if (Spin.isBead(h)) {
      const item = Spin.isUp(h) ? view.up[h - Spin.UP] : view.back[h - Spin.BACK];
      if (item) choice = { cmd: 'play', at: item.at, side: Spin.isUp(h) ? 'up' : 'back', k: h - (Spin.isUp(h) ? Spin.UP : Spin.BACK) };
    }
  }
  // Cancelled (or let go in the middle) after sliding the volume: put it back.
  if (spin.vol != null && spin.vol0 != null && (!choice || choice.cmd !== 'volume') && h !== Spin.SLICE.volume) Music.act(appId, 'volume', spin.vol0);
  spinLayer()?.send('spin:close', choice);
  spin.open = false;
  if (choice) {
    if (choice.cmd === 'play') Music.playAt(appId, Music.snapshot().list, choice.at);
    else if (choice.cmd === 'playlist') Music.playPlaylist(appId, choice.id);
    else if (choice.cmd === 'volume') Music.act(appId, 'volume', choice.value);
    else Music.act(appId, choice.cmd);
  }
  syncOverlays();
  ensurePoll();
}

ipcMain.handle('spin:status', async () => {
  const snap = await Music.refresh(settings.spin.app);
  return { ...snap, spotify: Music.spotifyAccount(), redirect: Music.REDIRECT };
});
ipcMain.handle('spotify:connect', async (_e, clientId) => {
  const result = await Music.connectSpotify(clientId);
  settingsWin?.show(); settingsWin?.focus(); // back from the browser
  if (result.ok) Music.refresh(settings.spin.app);
  return result;
});
ipcMain.handle('spin:playlists', (_e, opts) => Music.playlists(settings.spin.app, { fresh: !!opts?.fresh }));
ipcMain.handle('spin:playlist', (_e, id) => Music.playPlaylist(settings.spin.app, id));
ipcMain.on('spin:automation', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
ipcMain.on('spin:dashboard', () => shell.openExternal('https://developer.spotify.com/dashboard'));
ipcMain.on('clipboard:write', (_e, text) => { if (typeof text === 'string' && text.length < 200) clipboard.writeText(text); });
ipcMain.handle('spotify:disconnect', () => { Music.disconnectSpotify(); return Music.spotifyAccount(); });

// ---------- Away: blur every screen, hide the pointer, leave a note ----------
// One window per screen, above everything (Scrawl's layers included). macOS blurs what's behind it
// (vibrancy), so Away needs no screen-recording access. The page adds the drifting color and the note.
let away = null; // { since, preview, wins, closing, front }
let awayBinding = false; // the settings window is listening for new Away keys
let awayKeyOn = false; // the Away shortcut is registered

// ---------- shortcuts: Away's, Jot's and Tweak's, each when it's set to a shortcut rather than a double-tap ----------
// All set together, because the only way to drop one is to drop them all. Off while any are being chosen.
const SHORTCUT_NAME = { away: 'Away', jot: 'Jot', tweak: 'Tweak' };
const shortcutOn = { away: false, jot: false, tweak: false };
const shortcutBinding = { away: false, jot: false, tweak: false };
const usesShortcut = (tool) => settings[tool].enabled && settings[tool].mode === 'shortcut';
function registerShortcuts() {
  globalShortcut.unregisterAll();
  for (const t in shortcutOn) shortcutOn[t] = false;
  awayBinding = shortcutBinding.away;
  jotBinding = shortcutBinding.jot;
  tweakBinding = shortcutBinding.tweak;
  if (awayBinding || jotBinding || tweakBinding) { awayKeyOn = jotKeyOn = false; return; }
  const acts = { away: toggleAway, jot: () => { toggleComposer(); }, tweak: toggleTarget };
  for (const t in acts) {
    if (!usesShortcut(t)) continue;
    try { shortcutOn[t] = globalShortcut.register(settings[t].keys.accelerator, acts[t]); } catch { shortcutOn[t] = false; }
  }
  awayKeyOn = shortcutOn.away;
  jotKeyOn = shortcutOn.jot;
}
ipcMain.on('shortcut:bind', (_e, tool, on) => {
  if (!(tool in shortcutBinding)) return;
  shortcutBinding[tool] = !!on;
  if (on) { binding = false; if (menu.open) closeMenu(false); }
  registerShortcuts(); // off while listening, so the current keys reach the settings window too
});
ipcMain.handle('shortcut:keys', (_e, tool, keys) => {
  if (!(tool in shortcutBinding)) return { settings, error: null };
  shortcutBinding[tool] = false;
  const before = settings[tool].keys;
  const taken = Object.keys(SHORTCUT_NAME).find((t) => t !== tool && usesShortcut(t) && settings[t].keys.accelerator === keys.accelerator);
  let error = null;
  if (taken) error = `${keys.symbols.join('')} is already your ${SHORTCUT_NAME[taken]} keys. Pick other keys.`;
  else {
    settings = { ...settings, [tool]: { ...settings[tool], keys } };
    registerShortcuts();
    if (usesShortcut(tool) && !shortcutOn[tool]) {
      error = `${keys.symbols.join('')} is taken by another app. Pick other keys.`;
      settings = { ...settings, [tool]: { ...settings[tool], keys: before } };
    }
  }
  registerShortcuts();
  writeJSON('settings.json', settings);
  buildMenu();
  return { settings, error };
});

function toggleAway() {
  if (away) hideAway();
  else showAway(false);
}
// Or double-tap the Away key, when Away is set to that. It works while Away is up, to come back.
const awayTap = doubleTap({
  key: () => settings.away.key,
  on: () => settings.away.enabled && settings.away.mode === 'double' && !awayBinding && !binding,
  fire: () => { if (away?.preview) return; toggleAway(); },
});

// Step a window's opacity (vibrancy can't be faded with CSS, so the whole window fades).
function fadeWindow(w, from, to, ms, done) {
  const t0 = Date.now();
  w.setOpacity(from);
  const id = setInterval(() => {
    if (w.isDestroyed()) { clearInterval(id); done?.(); return; }
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = to > from ? 1 - (1 - k) ** 3 : k * k; // ease out on the way in, ease in on the way out
    w.setOpacity(from + (to - from) * e);
    if (k >= 1) { clearInterval(id); done?.(); }
  }, 16);
}

// The pointer can only be hidden by the app in front, so Away comes to the front while it's up.
// Note which app that was (lsappinfo needs no permission), so it can be put back afterwards.
function frontApp() {
  return new Promise((resolve) => {
    execFile('lsappinfo', ['front'], (err, asn) => {
      if (err || !asn.trim()) return resolve(null);
      execFile('lsappinfo', ['info', '-only', 'bundleid', asn.trim()], (err2, out) => {
        const id = !err2 && /"CFBundleIdentifier"="([^"]+)"/.exec(out)?.[1];
        resolve(id || null);
      });
    });
  });
}

function showAway(preview = false) {
  if (away) return;
  if (menu.open) closeMenu(false);
  cancelSpin();
  endTarget();
  penUp();
  if (activeTool) { activeTool = null; broadcast(); }
  binding = false;
  const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const a = { since: Date.now(), preview, wins: [], closing: false, front: null };
  away = a;
  if (!preview) frontApp().then((id) => { if (id && id !== 'com.pane.app' && !id.startsWith('com.github.Electron')) a.front = id; });
  // Bringing Pane forward (to hide the pointer) and closing Away later both make macOS look for another
  // Pane window to focus. If the settings window is open on a different Space, macOS would jump there.
  // So tuck it away first; it opens again from the Dock or the Pane menu.
  if (!preview && settingsWin?.isVisible() && !settingsWin.isFocused()) settingsWin.hide();
  // Only the app in front can hide the pointer, so Away comes forward only when it needs to.
  const takeFocus = preview || settings.away.hidePointer;

  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'fullscreen-ui',
      visualEffectState: 'active', // stay blurred even though nothing here is clicked
      hasShadow: false,
      // macOS rounds a frameless window's corners, and the blur with them. Screens with square corners
      // (most external displays) then show four sharp, unblurred slivers. Away covers the screen edge to edge.
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      type: 'panel',
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    const primary = d.id === cursor.id;
    w.setHiddenInMissionControl(true); // a background window, like Scrawl's layers (see createOverlays)
    w.setAlwaysOnTop(true, OVERLAY_LEVEL, 2); // above Scrawl's layers, so drawings blur too
    // Panels sit over full-screen apps without Electron's full-screen trick (see joinSpaces).
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.loadFile(path.join(__dirname, 'away.html'), { query: { primary: primary ? '1' : '0' } });
    w.once('ready-to-show', () => {
      if (away !== a || a.closing) return;
      w.setBounds(d.bounds);
      w.setOpacity(0);
      if (primary && takeFocus) { w.show(); w.focus(); app.focus({ steal: true }); }
      else w.showInactive();
      fadeWindow(w, 0, 1, 360);
    });
    a.wins.push(w);
  }
  buildMenu();
}

function hideAway() {
  const a = away;
  if (!a || a.closing) return;
  a.closing = true;
  for (const w of a.wins) if (!w.isDestroyed()) w.webContents.send('away:leave');
  // Hand the keyboard back *before* the Away windows close: to the app you were in, or to the settings
  // window after a preview (it's on the Space you're looking at). Otherwise macOS picks a Pane window
  // to focus by itself, and can jump to another Space to reach it.
  const close = () => {
    for (const w of a.wins) if (!w.isDestroyed()) fadeWindow(w, w.getOpacity(), 0, 260, () => { if (!w.isDestroyed()) w.destroy(); });
    setTimeout(() => { if (away === a) away = null; buildMenu(); }, 280);
  };
  if (a.preview) { settingsWin?.show(); settingsWin?.focus(); close(); }
  else if (a.front) execFile('osascript', ['-e', `tell application id "${a.front.replace(/"/g, '')}" to activate`], () => setTimeout(close, 60));
  else close();
}

ipcMain.handle('away:init', () => ({
  ...settings.away,
  mood: Tools.mood(settings.away.mood),
  since: away?.since ?? Date.now(),
  preview: !!away?.preview,
}));
ipcMain.on('away:show', () => showAway(true));
// The page asks to close only for a preview: the real thing ends with the shortcut.
ipcMain.on('away:dismiss', () => { if (away?.preview) hideAway(); });
// ---------- Jot: a quick note that comes back when its time is up ----------
// Double-tap the Jot key (or press its shortcut) and a note opens at the pointer. Write, maybe add a
// screenshot (and take it off again), pick a timer and send it off. When the time's up it comes back in the
// top-left corner of the main screen, where you can snooze it or be done with it.
// Never while Scrawl has a tool in hand, a wheel is up, Away is up or keys are being chosen.
let notes = []; // { id, text, image (a file in userData/jot), made, due, snoozed, showing }
let composer = null; // { win, front, shots: screenshots taken while it was open }
let jotBinding = false; // the settings window is listening for Jot's shortcut
let jotKeyOn = false; // Jot's shortcut is registered (shortcut mode only)
const toasts = new Map(); // note id -> { win, h }
const JOT_W = 380; // the note's window: its card plus room for the shadow
const TOAST_W = 352;
const jotDir = () => path.join(app.getPath('userData'), 'jot');
const saveNotes = () => writeJSON('jot.json', notes.map(({ showing, ...n }) => n));

function cleanAway(a) {
  const out = { ...DEFAULTS.away, ...a };
  if (!['shortcut', 'double'].includes(out.mode)) out.mode = DEFAULTS.away.mode;
  out.key = asCombo(out.key);
  return out;
}
function cleanJot(j) {
  const out = { ...DEFAULTS.jot, ...j };
  if (!['double', 'shortcut'].includes(out.mode)) out.mode = DEFAULTS.jot.mode;
  if (!JOT_SNOOZES.includes(out.snooze)) out.snooze = DEFAULTS.jot.snooze;
  out.last = Math.max(1, Math.min(1440, Math.round(Number(out.last)) || DEFAULTS.jot.last));
  out.key = asCombo(out.key);
  return out;
}
function jotBlocked() {
  return !settings.jot.enabled || !!activeTool || !!pen || menu.open || spin.open || !!spinTimer || !!away ||
    !!binding || awayBinding || jotBinding || tweakBinding;
}

// ---------- double-tap ----------
// Two quick taps of the key with nothing else pressed: each down and up within TAP_HOLD, the second
// pressed within TAP_GAP of the first being let go. Any other key (⌃C), a click, or a long hold starts over.
// Jot, Tweak and Away each have one, on their own key. With `hold` instead of `fire`, the second press
// acts the moment it goes down and the key stays held (Scrawl's and Spin's wheels): letting go is up to them.
const TAP_HOLD = 280, TAP_GAP = 400;
function doubleTap({ key, on, fire, hold }) {
  const tap = { downAt: 0, lastUp: 0 };
  const reset = () => { tap.downAt = 0; tap.lastUp = 0; };
  function feed(e, isDown) {
    if (!on()) return;
    const k = key();
    const mine = inCombo(k, e.keycode);
    if (mine) debug('tap', isDown ? 'down' : 'up', { downAt: tap.downAt, lastUp: tap.lastUp, others: isDown && othersHeld(k), held: [...down.keys()] });
    if (isDown) {
      if (!mine) { reset(); return; }
      if (tap.downAt) return; // still held
      if (othersHeld(k)) { reset(); return; }
      tap.downAt = Date.now();
      if (hold && tap.lastUp && tap.downAt - tap.lastUp < TAP_GAP) { tap.downAt = 0; tap.lastUp = 0; hold(); }
      return;
    }
    if (!mine || !tap.downAt) return;
    const now = Date.now(), began = tap.downAt, quick = now - began < TAP_HOLD;
    tap.downAt = 0;
    if (!quick) { tap.lastUp = 0; return; }
    if (tap.lastUp && began - tap.lastUp < TAP_GAP) { tap.lastUp = 0; fire(); } else tap.lastUp = now;
  }
  return { feed, reset };
}
const jotTapper = doubleTap({
  key: () => settings.jot.key,
  on: () => settings.jot.mode === 'double' && settings.jot.enabled,
  fire: () => { if (!jotBlocked()) openComposer(); },
});

// ---------- the note you write ----------
function jotPanel(opts) {
  const w = new BrowserWindow({
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    type: 'panel', show: false, acceptFirstMouse: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    ...opts,
  });
  w.setHiddenInMissionControl(true); // a background window, like Scrawl's layers (see createOverlays)
  w.setAlwaysOnTop(true, OVERLAY_LEVEL, 1); // over Scrawl's layers, under Away's
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  return w;
}

// The Jot key opens a note, and pressing it again while one is open puts it away (same as its ✕).
function toggleComposer() {
  if (composer) closeComposer();
  else if (!jotBlocked()) openComposer();
}

function openComposer(at) {
  if (composer) { // already writing one: bring it back
    if (!composer.win.isDestroyed()) { composer.win.show(); composer.win.focus(); app.focus({ steal: true }); }
    return;
  }
  const p = at || screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  const wa = d.workArea, H = 360;
  // The card's top-left corner lands just by the pointer (it grows out of there), kept on the screen.
  const x = Math.round(Math.min(Math.max(p.x - 34, wa.x + 4), wa.x + wa.width - JOT_W - 4));
  const y = Math.round(Math.min(Math.max(p.y - 26, wa.y + 4), wa.y + wa.height - H - 4));
  const c = { win: null, front: null, shots: new Set() };
  composer = c;
  frontApp().then((id) => { if (id && id !== 'com.pane.app' && !id.startsWith('com.github.Electron')) c.front = id; });
  // Like Away: a settings window on another Space would pull macOS over there when the note takes focus.
  if (settingsWin?.isVisible() && !settingsWin.isFocused()) settingsWin.hide();
  const w = jotPanel({ x, y, width: JOT_W, height: H });
  c.win = w;
  w.loadFile(path.join(__dirname, 'jot.html'), { query: { mode: 'compose' } });
  w.once('ready-to-show', () => {
    if (composer !== c || w.isDestroyed()) return;
    w.show(); w.focus(); app.focus({ steal: true });
  });
  // Screenshots taken but never sent (removed, retaken, or the note thrown away) leave with the window.
  w.on('closed', () => { if (composer === c) composer = null; for (const f of c.shots) dropShotFile(f); });
}
// A picture file goes once no note still points at it.
function dropShotFile(file) {
  if (typeof file !== 'string' || path.dirname(file) !== jotDir() || notes.some((n) => n.image === file)) return;
  fs.rm(file, { force: true }, () => {});
}
// Close the note and hand the keyboard back to the app you were in.
function closeComposer() {
  const c = composer;
  if (!c) return;
  composer = null;
  const w = c.win;
  const bye = () => { if (!w.isDestroyed()) w.destroy(); };
  if (c.front) execFile('osascript', ['-e', `tell application id "${c.front.replace(/"/g, '')}" to activate`], () => setTimeout(bye, 40));
  else bye();
}
const fromComposer = (e) => composer && !composer.win.isDestroyed() && e.sender === composer.win.webContents;

ipcMain.handle('jot:init', () => ({ last: settings.jot.last }));
ipcMain.on('jot:fit', (e, h) => {
  if (!fromComposer(e) || !(h > 100 && h < 900)) return;
  const w = composer.win, b = w.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const height = Math.ceil(h);
  const y = Math.max(wa.y + 4, Math.min(b.y, wa.y + wa.height - height - 4)); // grow upward if it would leave the screen
  w.setBounds({ x: b.x, y, width: JOT_W, height });
});
ipcMain.on('jot:cancel', (e) => { if (fromComposer(e)) closeComposer(); });
ipcMain.handle('jot:send', (e, { text, minutes, image }) => {
  if (!fromComposer(e)) return false;
  const m = Math.max(1, Math.min(1440, Math.round(Number(minutes)) || 15));
  const shot = typeof image === 'string' && path.dirname(image) === jotDir() && fs.existsSync(image) ? image : null;
  composer.shots.delete(shot);
  const now = Date.now();
  notes.push({ id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: String(text || '').slice(0, 1000), image: shot, made: now, due: now + m * 60000, minutes: m });
  saveNotes();
  if (settings.jot.last !== m) { settings = { ...settings, jot: { ...settings.jot, last: m } }; writeJSON('settings.json', settings); }
  closeComposer();
  jotChanged();
  return true;
});

const thumb = (img, w) => (img.getSize().width > w ? img.resize({ width: w, quality: 'good' }) : img).toDataURL();

// A screenshot with macOS's own tool: drag over part of the screen, or press Space and click a window.
// The note steps aside while you choose, and comes back with the picture.
ipcMain.handle('jot:shot', async (e) => {
  if (!fromComposer(e)) return null;
  const w = composer.win;
  if (systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { denied: true };
  }
  fs.mkdirSync(jotDir(), { recursive: true });
  const file = path.join(jotDir(), `${Date.now().toString(36)}.png`);
  w.setOpacity(0);
  w.hide();
  await new Promise((r) => setTimeout(r, 120));
  await new Promise((r) => execFile('screencapture', ['-i', '-x', '-o', file], () => r()));
  if (w.isDestroyed()) return null;
  w.show(); w.setOpacity(1); w.focus(); app.focus({ steal: true });
  if (!fs.existsSync(file)) return null; // Esc: nothing taken
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) { fs.rm(file, { force: true }, () => {}); return null; }
  composer?.shots.add(file);
  return { image: { path: file, url: thumb(img, 640) } };
});
// Taking a screenshot off the note you're writing: its file goes right away.
ipcMain.on('jot:dropShot', (e, file) => {
  if (!fromComposer(e) || !composer.shots.has(file)) return;
  composer.shots.delete(file);
  dropShotFile(file);
});

// ---------- reminders ----------
function checkNotes() {
  const now = Date.now();
  for (const n of notes) if (!n.showing && n.due <= now) showToast(n);
}
function showToast(n) {
  n.showing = true;
  const w = jotPanel({ width: TOAST_W, height: 200, focusable: false });
  toasts.set(n.id, { win: w, h: 200 });
  layoutToasts(false);
  w.loadFile(path.join(__dirname, 'jot.html'), { query: { mode: 'toast', id: n.id } });
  w.once('ready-to-show', () => { if (!w.isDestroyed()) { layoutToasts(false); w.showInactive(); } });
  w.on('closed', () => { toasts.delete(n.id); layoutToasts(true); });
  if (settings.jot.sound) execFile('afplay', ['-v', '0.6', '/System/Library/Sounds/Glass.aiff'], () => {});
  jotChanged();
}
// Top left of the main screen, newest at the bottom of the stack. Closing one slides the rest up.
function layoutToasts(animate) {
  const wa = screen.getPrimaryDisplay().workArea;
  let y = wa.y + 2;
  for (const t of toasts.values()) {
    if (t.win.isDestroyed()) continue;
    const b = { x: wa.x + 2, y, width: TOAST_W, height: t.h };
    if (y + t.h > wa.y + wa.height) b.y = Math.max(wa.y, wa.y + wa.height - t.h); // pile up at the bottom
    t.win.setBounds(b, animate && t.win.isVisible());
    y += t.h - 22; // the windows overlap by their shadow room
  }
}
const toastFor = (e) => [...toasts].find(([, t]) => !t.win.isDestroyed() && t.win.webContents === e.sender)?.[0];
const noteFor = (e) => notes.find((n) => n.id === toastFor(e));
function dropToast(id) {
  const t = toasts.get(id);
  if (t && !t.win.isDestroyed()) t.win.destroy();
}
function forget(n) {
  notes = notes.filter((x) => x !== n);
  if (n.image && !notes.some((x) => x.image === n.image)) fs.rm(n.image, { force: true }, () => {});
  saveNotes();
  jotChanged();
}

ipcMain.handle('jot:note', (e, id) => {
  const n = notes.find((x) => x.id === id);
  if (!n) return null;
  let image = null;
  if (n.image) { const img = nativeImage.createFromPath(n.image); if (!img.isEmpty()) image = thumb(img, 640); }
  return { text: n.text, made: n.made, minutes: n.minutes, snoozed: !!n.snoozed, image, snoozeFor: settings.jot.snooze };
});
ipcMain.on('jot:toastFit', (e, h) => {
  const id = toastFor(e);
  if (!id || !(h > 60 && h < 700)) return;
  toasts.get(id).h = Math.ceil(h);
  layoutToasts(false);
});
ipcMain.on('jot:done', (e) => { const n = noteFor(e); if (n) { dropToast(n.id); forget(n); } });
ipcMain.on('jot:gone', (e) => { const id = toastFor(e); if (id) dropToast(id); });
ipcMain.on('jot:snooze', (e) => {
  const n = noteFor(e);
  if (!n) return;
  dropToast(n.id);
  Object.assign(n, { showing: false, snoozed: true, due: Date.now() + settings.jot.snooze * 60000 });
  saveNotes();
  jotChanged();
});
ipcMain.on('jot:copy', (e) => { const n = noteFor(e); if (n?.text) clipboard.writeText(n.text); });
// Taking the screenshot off a reminder that came back: the note keeps its text.
ipcMain.on('jot:removeShot', (e) => {
  const n = noteFor(e);
  if (!n?.image) return;
  const file = n.image;
  n.image = null;
  saveNotes();
  dropShotFile(file);
  jotChanged();
});
ipcMain.on('jot:openShot', (e) => { const n = noteFor(e); if (n?.image) shell.openPath(n.image); });

// ---------- the settings page ----------
function jotList() {
  return notes.map((n) => ({ id: n.id, text: n.text, due: n.due, image: !!n.image, showing: !!n.showing, snoozed: !!n.snoozed }))
    .sort((a, b) => a.due - b.due);
}
function jotChanged() { settingsWin?.webContents.send('jot:changed', jotList()); }
ipcMain.handle('jot:list', () => jotList());
ipcMain.on('jot:cancel-note', (_e, id) => {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  dropToast(n.id);
  forget(n);
});
// Try it: a note opens in the middle of the settings window.
ipcMain.on('jot:try', () => {
  if (!settings.jot.enabled) return;
  const b = settingsWin?.getBounds();
  openComposer(b ? { x: Math.round(b.x + b.width / 2 - 150), y: Math.round(b.y + b.height / 2 - 150) } : undefined);
});
function setJotEnabled(on) {
  settings = { ...settings, jot: { ...settings.jot, enabled: !!on } };
  if (!on) closeComposer();
  writeJSON('settings.json', settings);
  registerShortcuts();
  buildMenu();
  settingsWin?.webContents.send('settings:changed', settings);
}

// ---------- Tweak: point at a file, click it, edit it ----------
// Double-tap the Tweak key (right ⌥ to start) and a layer covers every screen. As the pointer moves, the file
// under it on the desktop or in a Finder window lights up, with its name and type beside it. Click one and
// it opens in Tweak's editor. Esc, a right-click, a click on nothing or the key twice again puts it away.
// The file under the pointer comes from native/pane-files, which reads Finder through Accessibility.
const TweakFiles = require('./tweak-files.js');
let target = null; // { wins: Map(displayId -> BrowserWindow), helper, hit, asked, poll, at }
const editors = new Set(); // Tweak's editor windows

function cleanTweak(t) {
  const out = { ...DEFAULTS.tweak, ...t };
  if (!['double', 'shortcut'].includes(out.mode)) out.mode = DEFAULTS.tweak.mode;
  out.key = asCombo(out.key);
  out.copy = !!out.copy;
  out.trash = out.trash !== false;
  return out;
}
let tweakBinding = false; // the settings window is listening for Tweak's shortcut
function tweakBlocked() {
  return !settings.tweak.enabled || !!activeTool || !!pen || menu.open || spin.open || !!spinTimer || !!away ||
    !!binding || awayBinding || jotBinding || tweakBinding;
}
function toggleTarget() {
  debug('tweak', { target: !!target, blocked: tweakBlocked() });
  if (target) endTarget(); else if (!tweakBlocked()) startTarget();
}
const tweakTap = doubleTap({
  key: () => settings.tweak.key,
  on: () => settings.tweak.enabled && settings.tweak.mode === 'double',
  fire: toggleTarget,
});

// The helper sits inside app.asar's unpacked twin in the built app. While working on Pane it's built on first use.
function helperPath() {
  const p = path.join(__dirname, 'native', 'pane-files').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (!app.isPackaged) {
    try { require('./scripts/native.js').build({ quiet: true }); } catch (err) { console.warn('Couldn’t build Tweak’s helper:', err.message); }
  }
  return p;
}

function startTarget() {
  if (target) return;
  if (menu.open) closeMenu(false);
  cancelSpin();
  const t = { wins: new Map(), helper: null, hit: null, asked: false, key: '', poll: null, closing: false };
  target = t;
  const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      enableLargerThanScreen: true, acceptFirstMouse: true, type: 'panel', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    w.displayId = String(d.id);
    w.setHiddenInMissionControl(true); // a background window, like Scrawl's layers (see createOverlays)
    w.setAlwaysOnTop(true, OVERLAY_LEVEL, 1); // over Scrawl's layers, under Away's
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.loadFile(path.join(__dirname, 'target.html'), { query: { primary: d.id === here.id ? '1' : '0' } });
    w.once('ready-to-show', () => {
      if (target !== t || w.isDestroyed()) return;
      w.setBounds(d.bounds);
      w.showInactive();
      sendTargetHit(); // whatever is already under the pointer
    });
    t.wins.set(String(d.id), w);
  }
  // One helper for as long as the pointer is out; it answers one "x y" at a time.
  try {
    t.helper = spawn(helperPath(), ['hover', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    t.helper.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        t.asked = false;
        let hit = null;
        try { hit = JSON.parse(line); } catch {}
        debug('hover', line);
        if (target === t) onTargetHit(hit?.path ? hit : null);
      }
    });
    debug('helper', helperPath());
    t.helper.on('error', (err) => { console.warn('Tweak’s helper didn’t start:', err.message); t.helper = null; });
    t.helper.stdin.on('error', () => {});
  } catch (err) { console.warn('Tweak’s helper didn’t start:', err.message); }
  t.poll = setInterval(() => {
    if (!t.helper || t.asked) return;
    const p = screen.getCursorScreenPoint();
    const key = `${p.x},${p.y}`;
    // Ask again now and then even when still, since Finder may scroll or the window move under the pointer.
    if (key === t.key && Date.now() - (t.askedAt || 0) < 400) return;
    t.key = key;
    t.asked = true;
    t.askedAt = Date.now();
    t.helper.stdin.write(`${p.x} ${p.y}\n`);
  }, 30);
  buildMenu();
}

// Size, type and whether Tweak can open it. A file is looked at once per targeting.
const kindCache = new Map();
function onTargetHit(hit) {
  const t = target;
  if (!t) return;
  if (!hit) { if (t.hit) { t.hit = null; sendTargetHit(); } return; }
  const same = t.hit && t.hit.path === hit.path && t.hit.x === hit.x && t.hit.y === hit.y && t.hit.w === hit.w;
  if (same) return;
  let info = kindCache.get(hit.path);
  if (!info) {
    const k = TweakFiles.kindOf(hit.path, { dir: !!hit.dir });
    let size = null;
    try { if (!hit.dir) size = fs.statSync(hit.path).size; } catch {}
    info = { ...k, size, name: path.basename(hit.path) };
    kindCache.set(hit.path, info);
  }
  // Desktop icons: just around the picture itself (not its name). List rows: the row.
  const box = hit.desktop ? { x: hit.x - 2, y: hit.y - 2, w: hit.w + 4, h: hit.h + 4 } : { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
  t.hit = { ...hit, box, info };
  sendTargetHit();
}
function sendTargetHit() {
  const t = target;
  if (!t) return;
  const h = t.hit;
  const d = h ? screen.getDisplayNearestPoint({ x: Math.round(h.box.x + h.box.w / 2), y: Math.round(h.box.y + h.box.h / 2) }) : null;
  for (const [id, w] of t.wins) {
    if (w.isDestroyed()) continue;
    if (!h || String(d.id) !== id) { w.webContents.send('target:hit', null); continue; }
    const b = w.getBounds();
    w.webContents.send('target:hit', {
      x: h.box.x - b.x, y: h.box.y - b.y, w: h.box.w, h: h.box.h, desktop: !!h.desktop,
      name: h.info.name, label: h.info.label, size: h.info.size, ok: h.info.ok, why: h.info.why || null, kind: h.info.kind,
    });
  }
}
function endTarget(opening = false) {
  const t = target;
  if (!t || t.closing) return;
  t.closing = true;
  target = null;
  clearInterval(t.poll);
  try { t.helper?.stdin.end(); t.helper?.kill(); } catch {}
  kindCache.clear();
  for (const w of t.wins.values()) {
    if (w.isDestroyed()) continue;
    w.webContents.send('target:leave', { open: opening });
    setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 360); // after the marks have moved and faded
  }
  buildMenu();
}
// Clicks come from the global hook (like Scrawl's pen): the layer itself is faintly tinted so it takes the
// click and nothing lands in Finder or the app beneath.
function targetClick(button) {
  if (!target) return;
  if (button !== 1) { endTarget(); return; } // a right-click puts it away
  const h = target.hit;
  if (!h) { endTarget(); return; } // so does a click on nothing
  if (!h.info.ok) { for (const w of target.wins.values()) if (!w.isDestroyed()) w.webContents.send('target:nope'); return; }
  const file = h.path, from = h.box;
  endTarget(true);
  openEditor(file, from);
}

// ---------- the editor ----------
function openEditor(file, from = null) {
  // Already open: bring that window forward instead of a second one.
  for (const w of editors) if (!w.isDestroyed() && w.filePath === file) { w.show(); w.focus(); app.focus({ steal: true }); return w; }
  const p = from ? { x: Math.round(from.x + from.w / 2), y: Math.round(from.y + from.h / 2) } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(p), wa = display.workArea;
  const W = Math.min(1180, wa.width - 40), H = Math.min(780, wa.height - 40);
  const bounds = { x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + (wa.height - H) / 2), width: W, height: H };
  const w = new BrowserWindow({
    ...bounds, minWidth: 880, minHeight: 580,
    // No macOS title bar or traffic lights: the editor draws its own close and hide buttons in its bar.
    // Still resizable, rounded and shadowed like any window; ⌘W and ⌘M work from the Window menu.
    frame: false, backgroundColor: '#E4E5F3', show: false,
    fullscreenable: true, title: path.basename(file),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  w.filePath = file;
  editors.add(w);
  // Open on the Space you're looking at (even over a full-screen app), then stay there like any window.
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  w.loadFile(path.join(__dirname, 'edit.html'));
  // Opened from a file on screen: a stand-in grows out of it first, and the window appears where it lands.
  const ghost = from ? growGhost(display, from, bounds) : null;
  let ready = false, landed = !ghost;
  const reveal = () => {
    if (!ready || !landed || w.isDestroyed()) return;
    if (ghost) w.setOpacity(0);
    w.show(); w.focus(); app.focus({ steal: true });
    if (ghost) fadeWindow(w, 0, 1, 110, () => { if (!ghost.isDestroyed()) ghost.destroy(); });
    setTimeout(() => { if (!w.isDestroyed()) w.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }); }, 600);
  };
  w.once('ready-to-show', () => { ready = true; reveal(); });
  if (ghost) {
    const land = () => { if (!landed) { landed = true; reveal(); } };
    ghost.once('ready-to-show', () => setTimeout(land, 360)); // once the stand-in has finished growing
    setTimeout(land, 1500); // or regardless, if it's slow to appear
  }
  w.on('closed', () => { editors.delete(w); if (ghost && !ghost.isDestroyed()) ghost.destroy(); });
  return w;
}
// A see-through layer over the screen, where a stand-in of the editor springs out of the file (grow.html).
function growGhost(display, from, to) {
  const d = display.bounds;
  const g = new BrowserWindow({
    ...d, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, show: false, type: 'panel', enableLargerThanScreen: true,
    webPreferences: { backgroundThrottling: false },
  });
  g.setIgnoreMouseEvents(true);
  g.setHiddenInMissionControl(true);
  g.setAlwaysOnTop(true, OVERLAY_LEVEL, 1);
  g.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  const r = (a) => a.map((n) => Math.round(n)).join(',');
  g.loadFile(path.join(__dirname, 'grow.html'), { query: { from: r([from.x - d.x, from.y - d.y, from.w, from.h]), to: r([to.x - d.x, to.y - d.y, to.width, to.height]) } });
  g.once('ready-to-show', () => { if (!g.isDestroyed()) g.showInactive(); });
  setTimeout(() => { if (!g.isDestroyed()) g.destroy(); }, 3000); // never left behind
  return g;
}
const editorFor = (e) => [...editors].find((w) => !w.isDestroyed() && w.webContents === e.sender);

ipcMain.handle('tweak:load', async (e) => {
  const w = editorFor(e);
  if (!w) return null;
  try {
    const info = await TweakFiles.load(w.filePath);
    w.setTitle(info.name);
    w.setRepresentedFilename(w.filePath);
    return { ...info, prefs: { copy: settings.tweak.copy, trash: settings.tweak.trash } };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'That file isn’t there anymore.' : err.message, name: path.basename(w.filePath), path: w.filePath };
  }
});
// Text as a PDF: a hidden page prints it.
async function printPdf(html) {
  const pw = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await pw.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await pw.webContents.printToPDF({ pageSize: 'Letter', margins: { marginType: 'custom', top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 } });
  } finally { pw.destroy(); }
}
ipcMain.handle('tweak:save', async (e, job) => {
  const w = editorFor(e);
  if (!w || !job || typeof job.ext !== 'string' || !/^[a-z0-9]{1,10}$/.test(job.ext)) return { error: 'Nothing to save.' };
  // A typed ending (Other…) names the file; `ext` is still the type it's written as.
  if (job.ending != null && !TweakFiles.ENDING.test(job.ending)) return { error: 'An ending is letters and numbers, up to 15.' };
  const src = w.filePath;
  const p = TweakFiles.plan(src, { stem: job.stem, ext: job.ending || job.ext, copy: !!job.copy });
  const opts = {
    trash: settings.tweak.trash, trashItem: (f) => shell.trashItem(f), printPdf, helper: helperPath(),
    progress: (v) => { if (!w.isDestroyed()) w.webContents.send('tweak:progress', v); },
  };
  try {
    let dest;
    if (job.kind === 'image') dest = await TweakFiles.saveImage(src, job, p, opts);
    else if (job.kind === 'text') dest = await TweakFiles.saveText(src, job, p, opts);
    else if (job.kind === 'media') dest = await TweakFiles.saveMedia(src, job, p, opts);
    else return { error: 'Nothing to save.' };
    // Saved over (or replaced): the window now edits the new file. A copy keeps editing the original.
    if (p.replace) { w.filePath = dest; w.setTitle(path.basename(dest)); w.setRepresentedFilename(dest); }
    if (settings.tweak.copy !== !!job.copy) { settings = { ...settings, tweak: { ...settings.tweak, copy: !!job.copy } }; writeJSON('settings.json', settings); }
    return { ok: true, path: dest, name: path.basename(dest), replaced: p.replace, trashed: p.replace && settings.tweak.trash };
  } catch (err) {
    return { error: err.message || 'Saving didn’t work.' };
  }
});
// A new name (and maybe ending) for the file or folder in this window, straight away: nothing inside changes.
ipcMain.handle('tweak:rename', async (e, job) => {
  const w = editorFor(e);
  if (!w || !job || typeof job.stem !== 'string') return { error: 'Nothing to rename.' };
  try {
    const dest = await TweakFiles.rename(w.filePath, { stem: job.stem, ext: typeof job.ext === 'string' ? job.ext : undefined });
    w.filePath = dest; w.setTitle(path.basename(dest)); w.setRepresentedFilename(dest);
    return { ok: true, path: dest, name: path.basename(dest) };
  } catch (err) { return { error: err.message || 'Couldn’t rename it.' }; }
});
// A folder's contents, its totals, and Finder's own thumbnails, for the editor's folder views.
const okDir = (p) => typeof p === 'string' && path.isAbsolute(p);
ipcMain.handle('tweak:list', async (e, dir) => {
  if (!editorFor(e) || !okDir(dir)) return { error: 'Not a folder.' };
  try { return await TweakFiles.list(dir); } catch (err) { return { error: err.code === 'EACCES' || err.code === 'EPERM' ? 'Pane isn’t allowed to look in here.' : err.message }; }
});
ipcMain.handle('tweak:stats', async (e, dir) => {
  if (!editorFor(e) || !okDir(dir)) return null;
  try { return await TweakFiles.dirStats(dir); } catch { return null; }
});
ipcMain.handle('tweak:thumb', async (e, file, size = 256) => {
  if (!editorFor(e) || !okDir(file)) return null;
  const px = Math.max(32, Math.min(1024, Math.round(+size || 256)));
  try {
    const img = await nativeImage.createThumbnailFromPath(file, { width: px, height: px });
    if (!img.isEmpty()) return img.toDataURL();
  } catch {}
  try { return (await app.getFileIcon(file, { size: 'large' })).toDataURL(); } catch { return null; }
});
// A song's bytes, for drawing its waveform (decoded in the editor). Long files are skipped.
ipcMain.handle('tweak:bytes', async (e) => {
  const w = editorFor(e);
  if (!w) return null;
  try {
    if (fs.statSync(w.filePath).size > 80 * 1024 * 1024) return null;
    const b = await fs.promises.readFile(w.filePath);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  } catch { return null; }
});
// One frame of a video, saved as a picture beside it.
ipcMain.handle('tweak:frame', async (e, at) => {
  const w = editorFor(e);
  if (!w) return null;
  const src = w.filePath;
  const sec = Math.max(0, Number(at) || 0);
  const mm = `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
  const dest = TweakFiles.freeName(path.dirname(src), `${TweakFiles.stem(src)} frame ${mm}`, 'png');
  try {
    const out = await TweakFiles.run(helperPath(), ['frame', src, String(sec), dest]);
    if (!String(out).includes('"ok"')) throw new Error('Couldn’t grab that frame.');
    return { ok: true, path: dest, name: path.basename(dest) };
  } catch (err) { return { error: err.message }; }
});
// The editor's own window buttons (it has no title bar).
ipcMain.on('tweak:window', (e, what) => {
  const w = editorFor(e);
  if (!w) return;
  if (what === 'close') w.close();
  else if (what === 'hide') w.minimize();
});
ipcMain.on('tweak:reveal', (e, file) => {
  const w = editorFor(e);
  if (w && typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file);
});
// Open a different file in this window (from the editor's Open button or a file dropped on it).
ipcMain.handle('tweak:swap', async (e, file) => {
  const w = editorFor(e);
  if (!w) return false;
  let next = typeof file === 'string' && path.isAbsolute(file) && fs.existsSync(file) ? file : null;
  if (!next) {
    const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return false;
    next = r.filePaths[0];
  }
  w.filePath = next;
  return true;
});
async function chooseAndEdit(parent) {
  const r = await dialog.showOpenDialog(parent && !parent.isDestroyed() ? parent : undefined, { properties: ['openFile', 'openDirectory'], message: 'Pick a file or folder to tweak' });
  if (!r.canceled && r.filePaths[0]) openEditor(r.filePaths[0]);
}
ipcMain.on('tweak:choose', () => chooseAndEdit(settingsWin));
ipcMain.on('tweak:try', () => { if (settings.tweak.enabled && !target) startTarget(); });
ipcMain.on('tweak:prefs', (e, patch) => {
  if (!editorFor(e) || !patch) return;
  const next = { ...settings.tweak };
  if ('copy' in patch) next.copy = !!patch.copy;
  settings = { ...settings, tweak: cleanTweak(next) };
  writeJSON('settings.json', settings);
  settingsWin?.webContents.send('settings:changed', settings);
});
function setTweakEnabled(on) {
  settings = { ...settings, tweak: { ...settings.tweak, enabled: !!on } };
  if (!on) endTarget();
  writeJSON('settings.json', settings);
  buildMenu();
  settingsWin?.webContents.send('settings:changed', settings);
}

// ---------- settings window ----------
function createSettings() {
  settingsWin = new BrowserWindow({
    width: 900,
    height: 640,
    useContentSize: true,
    // Only its height can be dragged: the pages are laid out for 900pt across.
    // On a short screen the content scrolls instead of hiding under the menu bar.
    resizable: true,
    minWidth: 900,
    maxWidth: 900,
    minHeight: 360,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#E3E8EF',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    binding = false;
    settingsWin.hide();
  });
}

const trusted = () => systemPreferences.isTrustedAccessibilityClient(false);

// ---------- IPC ----------
ipcMain.handle('settings:get', () => ({ settings, trusted: trusted(), version: app.getVersion() }));
ipcMain.handle('settings:set', (_e, patch) => {
  if ('enabled' in patch) { setEnabled(patch.enabled); delete patch.enabled; }
  settings = { ...settings, ...patch };
  writeJSON('settings.json', settings);
  if ('openAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
  if ('away' in patch) { settings.away = cleanAway(settings.away); fitTapKey('awayKey'); registerShortcuts(); buildMenu(); }
  if ('wheelMode' in patch) {
    if (!['hold', 'double'].includes(settings.wheelMode)) settings.wheelMode = DEFAULTS.wheelMode;
    if (menu.open) closeMenu(false);
    fitTapKey('hotkey');
  }
  if ('spin' in patch) {
    if (!settings.spin.enabled) cancelSpin();
    if (!SPIN_COUNTS.includes(settings.spin.count)) settings.spin.count = DEFAULTS.spin.count;
    if (!WHEEL_SIZES.includes(settings.spin.size)) settings.spin.size = DEFAULTS.spin.size;
    settings.spin.wheel = cleanSpinWheel(settings.spin.wheel);
    if (!['hold', 'double'].includes(settings.spin.mode)) settings.spin.mode = DEFAULTS.spin.mode;
    fitTapKey('spinKey');
    buildMenu();
  }
  if ('jot' in patch) {
    settings.jot = cleanJot(settings.jot);
    if (!settings.jot.enabled) closeComposer();
    registerShortcuts();
    buildMenu();
  }
  if ('tweak' in patch) {
    settings.tweak = cleanTweak(settings.tweak);
    if (!settings.tweak.enabled) endTarget();
    registerShortcuts();
    buildMenu();
  }
  writeJSON('settings.json', settings);
  broadcast();
  return settings;
});

// Turning Scrawl off puts everything down: closes the wheel, lifts the pen, drops the tool,
// and fades the drawings away. They're kept and come back when it's turned on again.
function setEnabled(on) {
  on = !!on;
  if (settings.enabled === on) return;
  if (!on) {
    closeMenu(false);
    penUp();
    activeTool = null;
    holding = false;
  }
  settings = { ...settings, enabled: on };
  writeJSON('settings.json', settings);
  broadcast();
  buildMenu();
  settingsWin?.webContents.send('settings:changed', settings);
}
function setSpinEnabled(on) {
  settings = { ...settings, spin: { ...settings.spin, enabled: !!on } };
  if (!on) cancelSpin();
  writeJSON('settings.json', settings);
  broadcast();
  buildMenu();
  settingsWin?.webContents.send('settings:changed', settings);
}
ipcMain.handle('bind:start', (_e, which) => {
  if (!hookOn) return false; // can't hear keys yet: the settings screen explains why
  binding = which in KEY_LABEL ? which : 'hotkey';
  bindKeys = [];
  penUp();
  if (menu.open) closeMenu(false);
  cancelSpin();
  endTarget();
  return true;
});
// The settings page measures its tallest page, and the fixed-width window takes that height.
// The window's own color (seen for a moment while it resizes) follows the tool's theme.
ipcMain.on('window:bg', (_e, color) => { if (/^#[0-9a-f]{6}$/i.test(color)) settingsWin?.setBackgroundColor(color); });
// It never grows past the screen it's on: the window is kept inside the work area (below the menu bar,
// above the Dock), and anything taller scrolls.
ipcMain.on('window:fit', (_e, h, animate) => {
  if (!settingsWin || !(h > 300)) return; // no upper cap: the work area is the cap
  const area = screen.getDisplayMatching(settingsWin.getBounds()).workArea;
  const frame = settingsWin.getSize()[1] - settingsWin.getContentSize()[1]; // title bar, if any
  const height = Math.min(Math.ceil(h), area.height - frame);
  const b = settingsWin.getBounds();
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - (height + frame)));
  settingsWin.setContentBounds({ x: b.x, y: y + frame, width: 900, height }, !!animate && settingsWin.isVisible());
});
// Dragging the settings window's top or bottom edge by the grab strips (switcher.js).
let edgeDrag = null;
ipcMain.on('window:edge', (_e, phase, edge, y) => {
  if (!settingsWin) return;
  if (phase === 'start') { edgeDrag = { edge, y0: y, b: settingsWin.getBounds() }; return; }
  if (phase === 'end' || !edgeDrag) { edgeDrag = null; return; }
  const { b, y0 } = edgeDrag;
  const area = screen.getDisplayMatching(b).workArea;
  const min = settingsWin.getMinimumSize()[1] || 360;
  const dy = Math.round(y - y0);
  if (edgeDrag.edge === 'bottom') {
    const height = Math.max(min, Math.min(b.height + dy, area.y + area.height - b.y));
    settingsWin.setBounds({ ...b, height });
  } else {
    const top = Math.max(area.y, Math.min(b.y + dy, b.y + b.height - min));
    settingsWin.setBounds({ ...b, y: top, height: b.y + b.height - top });
  }
});
ipcMain.on('bind:cancel', () => { binding = false; });
// Pane's own update sheet in the settings window (see updater.js).
ipcMain.handle('update:get', () => Updater.get());
ipcMain.on('update:open', () => Updater.open());
ipcMain.on('update:later', () => Updater.later());
ipcMain.on('update:skip', () => Updater.skip());
ipcMain.on('update:install', () => Updater.install());
ipcMain.on('update:check', () => Updater.check({ manual: true }));
ipcMain.handle('perm:check', () => ({ trusted: trusted(), listening: hookOn, awayKey: shortcutOn.away, jotKey: shortcutOn.jot, tweakKey: shortcutOn.tweak }));
ipcMain.on('perm:open', () => {
  systemPreferences.isTrustedAccessibilityClient(true);
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});
ipcMain.on('app:relaunch', () => { app.relaunch(); app.exit(0); });

ipcMain.handle('overlay:init', (_e, id) => ({ strokes: drawings[id] || [], state: publicState() }));
ipcMain.on('stroke:add', (_e, id, stroke) => {
  (drawings[id] ||= []).push(stroke);
  record({ type: 'stroke', id, stroke });
  saveDrawingsSoon();
  syncOverlays();
});
ipcMain.on('tool:drop', dropTool);

// ---------- lifecycle ----------
app.whenReady().then(() => {
  migrateFromScrawl();
  settings = { ...DEFAULTS, ...readJSON('settings.json', {}) };
  settings.away = cleanAway(settings.away);
  if (!['hold', 'double'].includes(settings.wheelMode)) settings.wheelMode = DEFAULTS.wheelMode;
  const firstSpin = !settings.spin;
  // Spin's wheel used to share Scrawl's size: start it at that size, then they're set apart.
  const spinSize = settings.spin?.size ?? settings.wheelSize;
  settings.spin = { ...DEFAULTS.spin, ...settings.spin, size: spinSize };
  if (firstSpin) {
    // Spotify if it's on this Mac, else Apple Music (always there).
    const has = (name) => ['/Applications', path.join(app.getPath('home'), 'Applications')].some((d) => fs.existsSync(path.join(d, name)));
    settings.spin.app = has('Spotify.app') ? 'spotify' : 'music';
  }
  if (!['spotify', 'music', 'other'].includes(settings.spin.app)) settings.spin.app = DEFAULTS.spin.app;
  if (!SPIN_COUNTS.includes(settings.spin.count)) settings.spin.count = DEFAULTS.spin.count;
  // Held keys are combos now; settings from before hold a single key.
  settings.hotkey = asCombo(settings.hotkey);
  settings.drawKey = asCombo(settings.drawKey);
  settings.spin.key = asCombo(settings.spin.key);
  if (!['hold', 'double'].includes(settings.spin.mode)) settings.spin.mode = DEFAULTS.spin.mode;
  settings.jot = cleanJot({ ...DEFAULTS.jot, ...settings.jot });
  settings.tweak = cleanTweak(settings.tweak);
  // Spin's key can't be exactly one of Scrawl's (sharing some keys is fine): take a free right-hand modifier.
  if (sameCombo(settings.spin.key, settings.hotkey) || sameCombo(settings.spin.key, settings.drawKey)) {
    const free = [UiohookKey.MetaRight, UiohookKey.AltRight, UiohookKey.CtrlRight, UiohookKey.ShiftRight]
      .map((c) => combo([keyInfo(c)])).find((c) => !sameCombo(c, settings.hotkey) && !sameCombo(c, settings.drawKey));
    if (free) settings.spin.key = free;
  }
  if (!Tools.TOOLS.some((t) => t.id === settings.page)) settings.page = DEFAULTS.page;
  if (!WHEEL_SIZES.includes(settings.wheelSize)) settings.wheelSize = DEFAULTS.wheelSize;
  if (!WHEEL_SIZES.includes(settings.spin.size)) settings.spin.size = DEFAULTS.spin.size;
  settings.spin.wheel = cleanSpinWheel(settings.spin.wheel);
  for (const which of ['hotkey', 'spinKey', 'awayKey']) fitTapKey(which);
  // Keep the saved order, but make sure every built-in tool is present exactly once.
  const known = settings.tools.filter((t) => TOOL_IDS.includes(t.id));
  settings.tools = [...known, ...TOOL_IDS.filter((id) => !known.some((t) => t.id === id)).map((id) => ({ id, on: true }))];
  writeJSON('settings.json', settings); // save the migrated list (e.g. show/hide moved to the middle, undo/redo added)
  drawings = readJSON('drawings.json', {});
  notes = (readJSON('jot.json', []) || []).filter((n) => n && n.id && n.due);
  setInterval(checkNotes, 1000); // cheap, and right after sleep too

  createOverlays();
  createSettings();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, refreshOverlays);
  }
  registerShortcuts();
  buildMenu();
  askForAccess();
  // Without Accessibility access the hook can't start. Keep trying, so granting access
  // in System Settings takes effect without a restart.
  startHook();
  hookTimer = setInterval(startHook, 1500);
  // For trying Tweak from a terminal: PANE_TWEAK_OPEN=<file> opens it in the editor, PANE_TWEAK_TARGET=1 points.
  if (process.env.PANE_TWEAK_OPEN) setTimeout(() => openEditor(process.env.PANE_TWEAK_OPEN), 800);
  if (process.env.PANE_TWEAK_TARGET) setTimeout(startTarget, 1200);
  Updater.start({
    store: { get: () => readJSON('update.json', {}), set: (v) => writeJSON('update.json', v) },
    onState: (s) => settingsWin?.webContents.send('update:state', s),
    // Asked for (menu, button): come forward. Found in the background: appear without taking the keyboard,
    // so a key meant for another app can't press anything in the update sheet.
    reveal: (asked) => {
      if (!settingsWin) return;
      if (asked) { settingsWin.show(); settingsWin.focus(); app.focus({ steal: true }); } else if (!settingsWin.isVisible()) settingsWin.showInactive();
    },
  });
});

// Ask for everything Pane needs as it opens, rather than the first time a tool needs it:
// Accessibility (Scrawl's and Spin's keys) and Screen Recording (the color picker).
// macOS shows each prompt only once, so this never nags; the settings page still helps if one was declined.
function askForAccess() {
  if (process.env.SCRAWL_TEST) return;
  if (!trusted()) systemPreferences.isTrustedAccessibilityClient(true);
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    // Asking for a tiny screen photo is what makes macOS put up its Screen Recording prompt
    // (and adds Pane to the list in Privacy & Security). The photo itself is thrown away.
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch((err) => console.warn('Screen Recording request failed:', err.message));
  }
}

let hookOn = false;
let hookTimer = null;
let hookWarned = false;
function startHook() {
  if (!trusted() && !hookWarned && !app.isPackaged) { hookWarned = true; console.warn('Pane can’t hear keys: the app that started it (Terminal?) needs Accessibility access.'); }
  if (hookOn || !trusted()) return;
  try {
    uIOhook.start();
    hookOn = true;
    debug('key hook on');
    clearInterval(hookTimer);
  } catch (err) {
    console.warn('Key hook not started:', err.message);
  }
}

function buildMenu() {
  const show = () => { settingsWin.show(); settingsWin.focus(); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => Updater.check({ manual: true }) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: show },
        { label: settings.enabled ? 'Turn Scrawl Off' : 'Turn Scrawl On', click: () => setEnabled(!settings.enabled) },
        { label: settings.spin.enabled ? 'Turn Spin Off' : 'Turn Spin On', click: () => setSpinEnabled(!settings.spin.enabled) },
        { label: settings.jot.enabled ? 'Turn Jot Off' : 'Turn Jot On', click: () => setJotEnabled(!settings.jot.enabled) },
        { label: 'New Note', enabled: settings.jot.enabled, click: () => openComposer() },
        { label: settings.tweak.enabled ? 'Turn Tweak Off' : 'Turn Tweak On', click: () => setTweakEnabled(!settings.tweak.enabled) },
        { label: 'Tweak a File…', accelerator: 'Cmd+O', click: () => chooseAndEdit(BrowserWindow.getFocusedWindow()) },
        away
          ? { label: 'Come Back', click: hideAway }
          : { label: 'Step Away', ...(settings.away.mode === 'shortcut' ? { accelerator: settings.away.keys.accelerator, registerAccelerator: false } : {}), click: () => showAway(false) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { label: 'Pane', accelerator: 'Cmd+0', click: show },
      ],
    },
  ]));
}

app.on('activate', () => settingsWin?.show());
app.on('window-all-closed', () => { /* stay running: the overlay is the app */ });
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(saveTimer);
  if (drawings) writeJSON('drawings.json', drawings);
  globalShortcut.unregisterAll();
  uIOhook.stop();
  if (notes) saveNotes();
  endTarget();
});

// Test hook: only present when SCRAWL_TEST is set (used by automated checks, never in normal runs).
if (process.env.SCRAWL_TEST) {
  global.__scrawlTest = { startBind: (w) => { binding = w; bindKeys = []; }, settings: () => settings, spin, openSpin, closeSpin, spinHover, spinView, Music, applyTool, step, setEnabled, overlays, menu, showAway, hideAway, awayWins: () => away?.wins ?? [], jot: { open: openComposer, composer: () => composer, notes: () => notes, toasts, check: checkNotes, tap: jotTapper.feed, blocked: jotBlocked }, tweak: { start: startTarget, end: endTarget, target: () => target, open: openEditor, editors, tap: tweakTap, files: TweakFiles }, peek: () => ({ away: !!away, awayKey: awayKeyOn, activeTool, visible, menuOpen: menu.open, pencilColor: settings.pencilColor, enabled: settings.enabled, drawings, undo: history.undo.length, redo: history.redo.length }) };
}
