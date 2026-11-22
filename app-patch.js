// Small updates. Pane.app is ~250 MB, almost all of it the Electron framework, which hardly changes
// between releases: only app.asar, the Info.plists and the code signatures do (Electron also stamps a
// 32-byte hash of app.asar into its framework). So instead of the whole 120 MB disk image, a release can
// ship a patch from an earlier version: about a megabyte that turns that version's Pane.app into this one.
//
//   make(oldApp, newApp, outFile)   in the release workflow (scripts/make-patch.js)
//   apply(patchFile, oldApp, out)   in the updater: rebuilds the new Pane.app at `out` from the installed one
//
// apply() checks every file it writes against the new build's SHA-256, so a patch can only ever produce
// exactly the app the workflow built and signed. Anything unexpected throws, and the updater falls back to
// the full download.
//
// File format: gzip of [4-byte manifest length][manifest JSON][data]. Each manifest entry is one of
//   { path, kind: 'dir',  mode }
//   { path, kind: 'link', target }
//   { path, kind: 'file', mode, size, sha, from: 'old' }                    same bytes as the old app's file
//   { path, kind: 'file', mode, size, sha, from: 'old', ranges: [[at, n]] }  the old file, cut or grown to `size`,
//                                                                           with these bytes replaced
//   { path, kind: 'file', mode, size, sha, from: 'data' }                   whole file in the data
// Ranges and whole files are read from the data in manifest order.
// Inside Electron, plain `fs` treats .asar files as folders; original-fs reads them as the files they are.
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FORMAT = 1;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Every directory, link and file under `root`, parents before children, in a stable order.
function walk(root, rel = '', out = []) {
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink()) out.push({ path: r, kind: 'link', target: fs.readlinkSync(path.join(root, r)) });
    else if (st.isDirectory()) { out.push({ path: r, kind: 'dir', mode: st.mode & 0o7777 }); walk(root, r, out); }
    else if (st.isFile()) out.push({ path: r, kind: 'file', mode: st.mode & 0o7777, size: st.size });
  }
  return out;
}

// The byte ranges of `b` that differ from `a`, merged when they're close together. Where `b` is longer,
// its extra end is one more range. (A code signature often changes size, and it sits at the end of a file.)
function changedRanges(a, b) {
  const BLOCK = 4096, GAP = 64;
  const ranges = [];
  const both = Math.min(a.length, b.length);
  for (let i = 0; i < both; i += BLOCK) {
    const end = Math.min(i + BLOCK, both);
    if (a.subarray(i, end).equals(b.subarray(i, end))) continue;
    for (let j = i; j < end; j++) {
      if (a[j] === b[j]) continue;
      const last = ranges[ranges.length - 1];
      if (last && j - (last[0] + last[1]) <= GAP) last[1] = j - last[0] + 1;
      else ranges.push([j, 1]);
    }
  }
  if (b.length > both) {
    const last = ranges[ranges.length - 1];
    if (last && both - (last[0] + last[1]) <= GAP) last[1] = b.length - last[0];
    else ranges.push([both, b.length - both]);
  }
  return ranges;
}

function make(oldApp, newApp, outFile, info = {}) {
  const entries = walk(newApp);
  const chunks = [];
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const now = fs.readFileSync(path.join(newApp, e.path));
    e.sha = sha(now);
    const oldFile = path.join(oldApp, e.path);
    const st = fs.existsSync(oldFile) && fs.lstatSync(oldFile);
    if (st && st.isFile()) {
      const was = fs.readFileSync(oldFile);
      const ranges = changedRanges(was, now);
      const changed = ranges.reduce((n, [, len]) => n + len, 0);
      if (changed < now.length / 2) {
        e.from = 'old';
        if (ranges.length) {
          e.ranges = ranges;
          for (const [at, len] of ranges) chunks.push(now.subarray(at, at + len));
        }
        continue;
      }
    }
    e.from = 'data';
    chunks.push(now);
  }
  const manifest = Buffer.from(JSON.stringify({ format: FORMAT, ...info, entries }));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(manifest.length);
  const packed = zlib.gzipSync(Buffer.concat([head, manifest, ...chunks]), { level: 9 });
  fs.writeFileSync(outFile, packed);
  return { size: packed.length, entries: entries.length };
}

// Builds the new app at `out` (which must not exist yet). Files kept from the old app are cloned,
// which on APFS takes no time or space.
function apply(patchFile, oldApp, out) {
  const raw = zlib.gunzipSync(fs.readFileSync(patchFile));
  const len = raw.readUInt32BE(0);
  const manifest = JSON.parse(raw.subarray(4, 4 + len).toString());
  if (manifest.format !== FORMAT) throw new Error(`Unknown patch format ${manifest.format}`);
  let at = 4 + len;
  const take = (n) => {
    if (at + n > raw.length) throw new Error('The patch is cut short.');
    const b = raw.subarray(at, at + n);
    at += n;
    return b;
  };

  fs.mkdirSync(out);
  for (const e of manifest.entries) {
    if (typeof e.path !== 'string' || e.path.split('/').some((p) => p === '..' || p === '') || path.isAbsolute(e.path)) {
      throw new Error(`Bad path in patch: ${e.path}`);
    }
    const dest = path.join(out, e.path);
    if (e.kind === 'dir') { fs.mkdirSync(dest); fs.chmodSync(dest, e.mode); continue; }
    if (e.kind === 'link') { fs.symlinkSync(e.target, dest); continue; }
    if (e.kind !== 'file') throw new Error(`Unknown entry ${e.kind}`);

    let buf;
    if (e.from === 'old') {
      const src = path.join(oldApp, e.path);
      if (e.ranges) {
        const was = fs.readFileSync(src);
        buf = Buffer.alloc(e.size);
        was.copy(buf, 0, 0, Math.min(was.length, e.size));
        for (const [pos, n] of e.ranges) {
          if (pos + n > e.size) throw new Error(`Bad range in patch for ${e.path}`);
          take(n).copy(buf, pos);
        }
        fs.writeFileSync(dest, buf);
      } else {
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
      }
    } else if (e.from === 'data') {
      buf = take(e.size);
      fs.writeFileSync(dest, buf);
    } else {
      throw new Error(`Unknown source ${e.from}`);
    }
    if (sha(buf || fs.readFileSync(dest)) !== e.sha) {
      throw new Error(`${e.path} didn't come out as expected (the installed Pane may have been changed).`);
    }
    fs.chmodSync(dest, e.mode);
  }
  if (at !== raw.length) throw new Error('The patch has data left over.');
  return manifest;
}

module.exports = { make, apply, _test: { changedRanges, walk } };
