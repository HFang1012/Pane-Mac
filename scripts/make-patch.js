// Makes a small update from an older Pane.app to a newer one (see app-patch.js).
//   node scripts/make-patch.js <old Pane.app> <new Pane.app> <out.patch>
// Then it applies the patch to a scratch copy and checks the result matches the new app exactly,
// so a broken patch never gets published.
const { make, apply } = require('../app-patch.js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [oldApp, newApp, out] = process.argv.slice(2);
if (!oldApp || !newApp || !out) {
  console.error('Usage: node scripts/make-patch.js <old Pane.app> <new Pane.app> <out.patch>');
  process.exit(1);
}
const version = (app) => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.join(app, 'Contents', 'Info.plist')]).toString().trim();

const from = version(oldApp), to = version(newApp);
const { size } = make(oldApp, newApp, out, { from, to });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-patch-check-'));
try {
  const rebuilt = path.join(work, 'Pane.app');
  apply(out, oldApp, rebuilt);
  execFileSync('diff', ['-rq', '--no-dereference', rebuilt, newApp], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', rebuilt], { stdio: 'inherit' });
} catch (err) {
  fs.rmSync(out, { force: true });
  console.error(`The ${from} → ${to} patch didn't rebuild the new app exactly; not keeping it.`);
  process.exit(1);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`Made ${path.basename(out)}: ${from} → ${to}, ${(size / 1024 / 1024).toFixed(2)} MB`);
