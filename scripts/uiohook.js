// Rebuilds the key hook (uiohook-napi) so macOS never wakes Pane for mouse movement or scrolling.
//
// Stock uiohook-napi asks macOS for every mouse-moved, dragged and scroll event as well as keys and
// clicks, and hands each one to JavaScript. Pane only listens for keys and clicks, so moving the mouse
// cost CPU for nothing. This takes those events out of the hook's CGEventTap mask, so macOS doesn't
// send them at all, then builds the addon and puts it where uiohook-napi loads it from (its own
// prebuilds/darwin-<arch> folder, which scripts/package.js copies into Pane.app).
//
//   node scripts/uiohook.js          patches and builds if the shipped addon isn't the patched one
//   node scripts/uiohook.js --force  always builds
// Runs after every npm install / npm ci (package.json "postinstall"), and again from npm run package.
// The addon uses N-API, so one build works in Node and in every Electron version. Needs Xcode or the
// Command Line Tools, like scripts/native.js.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'uiohook-napi');
const hookFile = path.join(pkg, 'libuiohook', 'src', 'darwin', 'input_hook.c');
const out = path.join(pkg, 'prebuilds', `darwin-${process.arch}`, 'uiohook-napi.node');
const stamp = path.join(pkg, `.pane-hook-${process.arch}`); // hash of the patched source the addon was built from

// The event types Pane never listens for. Each is one "CGEventMaskBit(...) |" term in the mask.
const DROPPED = ['kCGEventLeftMouseDragged', 'kCGEventRightMouseDragged', 'kCGEventOtherMouseDragged', 'kCGEventMouseMoved', 'kCGEventScrollWheel'];

function patch() {
  let src = fs.readFileSync(hookFile, 'utf8');
  const start = src.indexOf('CGEventMask event_mask =');
  const end = src.indexOf(';', start);
  if (start < 0 || end < 0) throw new Error(`Couldn't find the event mask in ${hookFile}; uiohook-napi changed, so check this script.`);
  let mask = src.slice(start, end);
  for (const type of DROPPED) {
    const term = new RegExp(`CGEventMaskBit\\(${type}\\)\\s*\\|\\s*`);
    if (term.test(mask)) mask = mask.replace(term, '');
    else if (mask.includes(type)) throw new Error(`Couldn't take ${type} out of the event mask in ${hookFile}.`);
  }
  if (!mask.includes('kCGEventKeyDown') || !mask.includes('kCGEventLeftMouseDown')) {
    throw new Error(`The patched event mask lost keys or clicks:\n${mask}`);
  }
  src = src.slice(0, start) + mask + src.slice(end);
  fs.writeFileSync(hookFile, src);
  return crypto.createHash('sha256').update(src).digest('hex');
}

// node-gyp: npm passes its own copy's path to install scripts; otherwise use the one npm ships with.
function nodeGyp() {
  const candidates = [
    process.env.npm_config_node_gyp,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("Couldn't find node-gyp to build the key hook (it comes with npm).");
  return found;
}

function build({ force = false, quiet = false } = {}) {
  if (process.platform !== 'darwin') return null;
  if (!fs.existsSync(hookFile)) throw new Error('uiohook-napi is missing its libuiohook source; run npm ci.');
  const hash = patch();
  const fresh = fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === hash;
  if (fresh && !force) return out;
  execFileSync(process.execPath, [nodeGyp(), 'rebuild', '--release'], { cwd: pkg, stdio: quiet ? 'ignore' : 'inherit' });
  const built = path.join(pkg, 'build', 'Release', 'uiohook_napi.node');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(built, out);
  fs.writeFileSync(stamp, `${hash}\n`);
  // node-gyp-build would load build/Release first; leaving only the prebuild keeps one copy, in one place.
  fs.rmSync(path.join(pkg, 'build'), { recursive: true, force: true });
  if (!quiet) console.log(`Built ${path.relative(root, out)} without mouse-move and scroll events`);
  return out;
}

if (require.main === module) {
  try {
    build({ force: process.argv.includes('--force') });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
module.exports = { build, out };
