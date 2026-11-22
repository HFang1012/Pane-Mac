// Builds Tweak's native helper, native/pane-files, from native/pane-files.swift (see that file).
//   node scripts/native.js          builds it if the Swift file is newer than the binary
//   node scripts/native.js --force  always builds
// npm run package runs this first. Needs Xcode or the Command Line Tools (swiftc).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'pane-files.swift');
const out = path.join(root, 'native', 'pane-files');

function build({ force = false, quiet = false } = {}) {
  const fresh = fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs;
  if (fresh && !force) return out;
  execFileSync('swiftc', ['-O', '-suppress-warnings', src, '-o', out], { stdio: quiet ? 'ignore' : 'inherit' });
  if (!quiet) console.log(`Built ${path.relative(root, out)}`);
  return out;
}

if (require.main === module) build({ force: process.argv.includes('--force') });
module.exports = { build, out };
