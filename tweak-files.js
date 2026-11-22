// Tweak's file work, apart from its windows: what kind of file something is, reading it for the editor,
// and writing the edited version back (in place, renamed to a new type, or as a copy).
//
// Pictures are drawn and encoded in the editor (a canvas); macOS's sips turns them into types a canvas
// can't write (HEIC, TIFF, GIF…). Words go through textutil for Word, RTF and OpenDocument files.
// Video and sound go through native/pane-files (AVFoundation).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'avif', 'ico', 'icns', 'psd', 'tga', 'jp2'];
const BROWSER_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']; // the editor can read these as they are
const VIDEO = ['mp4', 'mov', 'm4v', '3gp'];
const AUDIO = ['mp3', 'm4a', 'wav', 'aiff', 'aif', 'caf', 'aac', 'flac'];
const RICH = ['rtf', 'doc', 'docx', 'odt', 'webarchive', 'wordml'];
const TEXT = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'sql', 'env', 'gitignore', 'plist', 'tex', 'srt', 'vtt', 'lua', 'r', 'dart', 'vue', 'svelte', 'scss', 'less'];
const NOT_YET = { webm: 'WebM video', mkv: 'MKV video', avi: 'AVI video', pdf: 'PDF', zip: 'archive', dmg: 'disk image', pages: 'Pages document', key: 'Keynote deck', numbers: 'Numbers sheet' };

// What the "Save as" menu offers for each kind. Video can also become just its sound.
const FORMATS = {
  image: ['png', 'jpg', 'webp', 'heic', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf'],
  video: ['mp4', 'mov', 'm4v', 'gif', 'm4a', 'wav', 'aiff', 'caf'],
  audio: ['m4a', 'wav', 'aiff', 'caf'],
  text: ['txt', 'md', 'json', 'csv', 'html', 'xml', 'yaml', 'js', 'css', 'py', 'rtf', 'docx', 'odt', 'pdf'],
};
const TEXTUTIL_OUT = { rtf: 'rtf', docx: 'docx', doc: 'doc', odt: 'odt', webarchive: 'webarchive', wordml: 'wordml' };
const SIPS_OUT = { heic: 'heic', avif: 'avif', tiff: 'tiff', tif: 'tiff', gif: 'gif', bmp: 'bmp', ico: 'ico', pdf: 'pdf', jp2: 'jp2', psd: 'psd', tga: 'tga' };
const LABEL = {
  png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', webp: 'WebP image', heic: 'HEIC photo', heif: 'HEIF photo', avif: 'AVIF image',
  tiff: 'TIFF image', tif: 'TIFF image', gif: 'GIF', bmp: 'Bitmap', ico: 'Icon', icns: 'Mac icon', psd: 'Photoshop file', pdf: 'PDF',
  mp4: 'MP4 video', mov: 'QuickTime movie', m4v: 'M4V video', '3gp': '3GP video',
  mp3: 'MP3 audio', m4a: 'M4A audio', wav: 'WAV audio', aiff: 'AIFF audio', aif: 'AIFF audio', caf: 'CAF audio', aac: 'AAC audio', flac: 'FLAC audio',
  txt: 'Plain text', md: 'Markdown', markdown: 'Markdown', json: 'JSON', csv: 'CSV table', tsv: 'TSV table', html: 'Web page', htm: 'Web page',
  css: 'Stylesheet', js: 'JavaScript', ts: 'TypeScript', py: 'Python', xml: 'XML', svg: 'SVG drawing', yaml: 'YAML', yml: 'YAML',
  rtf: 'Rich text', doc: 'Word 97 document', docx: 'Word document', odt: 'OpenDocument text', webarchive: 'Web archive',
};

const extOf = (file) => {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.startsWith('.') ? base.slice(1).toLowerCase() : '';
};
const stem = (file) => {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

// Plain text if the start of the file has no zero bytes and reads as UTF-8.
function looksLikeText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const b = buf.subarray(0, n);
    if (b.includes(0)) return false;
    return !new TextDecoder('utf-8', { fatal: false }).decode(b).includes('�');
  } catch { return false; }
}

// { kind: image|video|audio|text|rich|dir|other, label, ok, why }
function kindOf(file, { dir = false } = {}) {
  const ext = extOf(file);
  if (dir) return { kind: 'dir', ext: '', label: 'Folder', ok: true };
  if (IMAGE.includes(ext)) return { kind: 'image', ext, label: LABEL[ext] || `${ext.toUpperCase()} image`, ok: true };
  if (VIDEO.includes(ext)) return { kind: 'video', ext, label: LABEL[ext] || 'Video', ok: true };
  if (AUDIO.includes(ext)) return { kind: 'audio', ext, label: LABEL[ext] || 'Audio', ok: true };
  if (RICH.includes(ext)) return { kind: 'rich', ext, label: LABEL[ext] || 'Document', ok: true };
  if (NOT_YET[ext]) return { kind: 'other', ext, label: NOT_YET[ext], ok: false, why: `Tweak can’t edit a ${NOT_YET[ext]} yet` };
  if (TEXT.includes(ext)) return { kind: 'text', ext, label: LABEL[ext] || `${ext.toUpperCase()} file`, ok: true };
  try { if (fs.statSync(file).size > 20 * 1024 * 1024) return { kind: 'other', ext, label: 'File', ok: false, why: 'Too big to open as text' }; } catch {}
  if (looksLikeText(file)) return { kind: 'text', ext, label: ext ? `${ext.toUpperCase()} file` : 'Text', ok: true };
  return { kind: 'other', ext, label: ext ? `${ext.toUpperCase()} file` : 'File', ok: false, why: 'Tweak can’t edit this kind of file' };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().split('\n').pop() || 'Failed'));
      else resolve(stdout);
    });
  });
}
const tmpFile = (ext) => path.join(os.tmpdir(), `pane-tweak-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`);

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' };

// Everything the editor needs to show a file.
async function load(file) {
  const st = await fsp.stat(file);
  const k = kindOf(file, { dir: st.isDirectory() });
  const info = {
    path: file, dir: path.dirname(file), name: path.basename(file), stem: k.kind === 'dir' ? path.basename(file) : stem(file), ext: k.ext, kind: k.kind, label: k.label,
    ok: k.ok, why: k.why || null, size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, url: require('url').pathToFileURL(file).href,
  };
  if (!k.ok || k.kind === 'dir') return info;
  if (k.kind === 'image') {
    let src = file, mime = MIME[k.ext];
    if (!BROWSER_IMAGE.includes(k.ext)) { // HEIC, TIFF, PSD…: sips makes a PNG the editor can draw
      src = tmpFile('png');
      await run('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', src]);
      mime = 'image/png';
    }
    info.image = `data:${mime};base64,${(await fsp.readFile(src)).toString('base64')}`;
    if (src !== file) fsp.rm(src, { force: true }).catch(() => {});
  } else if (k.kind === 'text') {
    info.text = await fsp.readFile(file, 'utf8');
  } else if (k.kind === 'rich') {
    info.text = (await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file])).toString();
  }
  info.formats = FORMATS[k.kind === 'rich' ? 'text' : k.kind].slice();
  // The file's own type is always offered (a .ts stays a .ts), first among its kind.
  const own = k.ext === 'jpeg' ? 'jpg' : k.ext === 'tif' ? 'tiff' : k.ext;
  if (own && !info.formats.includes(own) && (k.kind === 'text' || k.kind === 'rich' || SIPS_OUT[own] || ['png', 'jpg', 'webp'].includes(own))) info.formats.unshift(own);
  info.own = own;
  return info;
}

// ---------- names ----------
// A new name, and for a file maybe a new ending, with nothing inside changed. `ext` undefined keeps the ending.
// A folder's whole name is its name (no ending). A change of case alone is allowed on macOS's disks.
async function rename(src, { stem: newStem, ext }) {
  const st = await fsp.stat(src);
  const isDir = st.isDirectory();
  const keepExt = isDir ? '' : extOfName(path.basename(src));
  const end = isDir ? '' : ext === undefined ? keepExt : String(ext || '');
  if (end && !ENDING.test(end)) throw new Error('An ending is letters and numbers, up to 15.');
  const base = cleanStem(newStem, isDir ? path.basename(src) : stem(src));
  const dest = path.join(path.dirname(src), `${base}${end ? `.${end}` : ''}`);
  if (dest === src) return src;
  try {
    const there = await fsp.stat(dest);
    if (there.ino !== st.ino) throw Object.assign(new Error(`There’s already a ${path.basename(dest)} there.`), { taken: true });
  } catch (err) { if (err.taken) throw err; }
  await fsp.rename(src, dest);
  return dest;
}
// The ending as written (not lowercased), so a rename keeps "Photo.JPG" as it was.
const extOfName = (base) => { const dot = base.lastIndexOf('.'); return dot > 0 ? base.slice(dot + 1) : ''; };
const ENDING = /^[A-Za-z0-9_-]{1,15}$/;

// ---------- folders ----------
// What's in a folder, one level down, for the editor's Finder-like views. Hidden files stay hidden.
async function list(dir, { hidden = false, max = 3000 } = {}) {
  const ents = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => hidden || !d.name.startsWith('.'));
  const out = await Promise.all(ents.slice(0, max).map(async (d) => {
    const p = path.join(dir, d.name);
    let st = null;
    try { st = await fsp.stat(p); } catch {}
    const isDir = st ? st.isDirectory() : d.isDirectory();
    // Apps and other bundles are folders on disk but files to everyone: they open as themselves, not inside.
    const bundle = isDir && /\.(app|bundle|framework|pkg|photoslibrary|rtfd)$/i.test(d.name);
    const k = kindOf(p, { dir: isDir && !bundle });
    return { name: d.name, path: p, dir: isDir && !bundle, size: st && !isDir ? st.size : null, mtime: st?.mtimeMs ?? null, ctime: st?.birthtimeMs ?? null, kind: k.kind, label: bundle ? 'Package' : k.label, ext: k.ext, ok: bundle ? false : k.ok };
  }));
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { entries: out, more: ents.length > max };
}
// Everything under a folder, counted: files, folders, bytes and kinds. Huge folders stop early and say so.
async function dirStats(dir, { maxEntries = 40000, maxMs = 2500 } = {}) {
  const t0 = Date.now();
  const s = { files: 0, folders: 0, bytes: 0, kinds: {}, partial: false, top: 0 };
  const queue = [dir];
  let first = true;
  while (queue.length) {
    if (s.files + s.folders > maxEntries || Date.now() - t0 > maxMs) { s.partial = true; break; }
    const d = queue.shift();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    if (first) { s.top = ents.filter((e) => !e.name.startsWith('.')).length; first = false; }
    await Promise.all(ents.map(async (e) => {
      if (e.name.startsWith('.')) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { s.folders++; queue.push(p); return; }
      if (e.isSymbolicLink()) return;
      s.files++;
      try { s.bytes += (await fsp.stat(p)).size; } catch {}
      const k = kindOf(p).kind;
      const key = k === 'rich' ? 'text' : k;
      s.kinds[key] = (s.kinds[key] || 0) + 1;
    }));
  }
  return s;
}

// A name that isn't taken in this folder: "Photo.png", then "Photo 2.png", "Photo 3.png"…
function freeName(dir, base, ext, except) {
  const name = (n) => path.join(dir, `${base}${n > 1 ? ` ${n}` : ''}${ext ? `.${ext}` : ''}`);
  for (let n = 1; n < 1000; n++) {
    const p = name(n);
    if (p === except || !fs.existsSync(p)) return p;
  }
  return name(Date.now());
}
const cleanStem = (s, fallback) => String(s || '').replace(/[/:\u0000]/g, '-').replace(/^\.+/, '').trim().slice(0, 200) || fallback;

// Where the edit lands, and what happens to the original.
//   copy: a new file beside it ("Photo copy.png"), the original stays.
//   otherwise: the original is replaced. Same name and type: overwritten in place. A new name or type:
//   the new file appears and the original goes (to the Trash, unless `trash` is off).
// `ext` is what the new file is named with; it may be an ending the user typed, not the type it's written as.
function plan(src, { stem: newStem, ext, copy }) {
  const dir = path.dirname(src);
  const base = cleanStem(newStem, stem(src));
  if (copy) return { dest: freeName(dir, base === stem(src) ? `${base} copy` : base, ext), replace: false };
  const want = path.join(dir, `${base}${ext ? `.${ext}` : ''}`);
  if (want === src) return { dest: src, replace: true, inPlace: true };
  return { dest: freeName(dir, base, ext, src), replace: true, inPlace: false };
}

// Put the finished temp file where it belongs, sending the original away if it's being replaced.
// Saved over itself, the file is changed, not swapped for a new one: the new contents are written into the
// same file, so Finder (and an app's Open dialog) sees it update in place, and it keeps its tags, comments,
// Date Added and spot in the folder. With `trash` on, a copy of the old version goes to the Trash first.
async function settle(src, tmp, p, { trash, trashItem }) {
  if (p.inPlace) {
    if (trash) {
      const keep = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'pane-tweak-old-')), path.basename(src));
      await fsp.copyFile(src, keep, fs.constants.COPYFILE_FICLONE); // a clone on APFS: instant, whatever the size
      await trashItem(keep); // it shows in the Trash under the file's own name
      fsp.rm(path.dirname(keep), { recursive: true, force: true }).catch(() => {});
    }
    // 'w' empties the same file and writes into it; it doesn't make a new one.
    const chunk = 8 * 1024 * 1024; // big pieces: a large video writes back several times faster than in 64 KB ones
    await pipeline(fs.createReadStream(tmp, { highWaterMark: chunk }), fs.createWriteStream(src, { flags: 'w', highWaterMark: chunk }));
    await fsp.rm(tmp, { force: true });
  } else {
    await fsp.rename(tmp, p.dest);
    if (p.replace) { if (trash) await trashItem(src); else await fsp.rm(src, { force: true }); }
  }
  return p.dest;
}
// The temp file sits in the same folder (so the last step is a quick rename), hidden until it's done.
const sideTmp = (dest, ext) => path.join(path.dirname(dest), `.pane-tweak-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext || 'tmp'}`);

// ---------- pictures ----------
// `bytes` come from the editor's canvas, already encoded as `encoded` (png, jpeg or webp).
async function saveImage(src, { bytes, encoded, ext, quality }, p, opts) {
  const tmp = sideTmp(p.dest, ext);
  const buf = Buffer.from(bytes);
  try {
    const native = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' }[ext];
    if (native === encoded) {
      await fsp.writeFile(tmp, buf);
    } else {
      const fmt = SIPS_OUT[ext];
      if (!fmt) throw new Error(`Pane can’t write .${ext} pictures.`);
      const png = tmpFile('png');
      await fsp.writeFile(png, buf);
      try {
        if (fmt === 'ico') await run('/usr/bin/sips', ['-Z', '256', png]); // icons top out at 256 px
        const args = ['-s', 'format', fmt];
        if (['heic', 'avif', 'jp2'].includes(fmt) && quality) args.push('-s', 'formatOptions', String(Math.round(quality * 100)));
        await run('/usr/bin/sips', [...args, png, '--out', tmp]);
      } finally { fsp.rm(png, { force: true }).catch(() => {}); }
    }
    return await settle(src, tmp, p, opts);
  } catch (err) { fsp.rm(tmp, { force: true }).catch(() => {}); throw err; }
}

// ---------- words ----------
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
async function saveText(src, { text, ext }, p, opts) {
  const tmp = sideTmp(p.dest, ext);
  try {
    if (TEXTUTIL_OUT[ext]) {
      const txt = tmpFile('txt');
      await fsp.writeFile(txt, text, 'utf8');
      try { await run('/usr/bin/textutil', ['-convert', TEXTUTIL_OUT[ext], '-output', tmp, txt]); } finally { fsp.rm(txt, { force: true }).catch(() => {}); }
    } else if (ext === 'pdf') {
      await fsp.writeFile(tmp, await opts.printPdf(`<!doctype html><meta charset="utf-8"><style>body{font:11pt/1.5 -apple-system,system-ui,sans-serif;margin:0;white-space:pre-wrap;word-wrap:break-word;color:#111}</style><body>${escapeHtml(text)}</body>`));
    } else {
      await fsp.writeFile(tmp, text, 'utf8');
    }
    return await settle(src, tmp, p, opts);
  } catch (err) { fsp.rm(tmp, { force: true }).catch(() => {}); throw err; }
}

// ---------- video and sound ----------
function saveMedia(src, { ops, ext }, p, opts) {
  const tmp = sideTmp(p.dest, ext);
  return new Promise((resolve, reject) => {
    const job = { input: src, output: tmp, format: ext, ...ops };
    const child = spawn(opts.helper, ['media', JSON.stringify(job)]);
    let last = null, buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (typeof m.progress === 'number') opts.progress?.(m.progress);
          else last = m;
        } catch {}
      }
    });
    child.on('error', (err) => reject(err));
    child.on('close', async () => {
      if (!last?.ok) { fsp.rm(tmp, { force: true }).catch(() => {}); reject(new Error(last?.error || 'Saving didn’t work.')); return; }
      try { resolve(await settle(src, tmp, p, opts)); } catch (err) { fsp.rm(tmp, { force: true }).catch(() => {}); reject(err); }
    });
  });
}

module.exports = { kindOf, load, plan, rename, list, dirStats, ENDING, saveImage, saveText, saveMedia, freeName, extOf, stem, FORMATS, LABEL, run };
