// Builds build/Pane.app for this Mac and signs it so macOS will open it.
//
// Signing: macOS remembers permissions (Accessibility, Screen Recording, Automation) by the app's signature.
// An ad-hoc signature is new on every build, so each update looked like a different app and lost them all.
// So Pane is signed with its own long-lived certificate, "Pane Signing", and every build keeps the same identity.
// The certificate is a .p12 file plus its password, from (first found):
//   PANE_SIGN_P12 (base64 of the .p12) and PANE_SIGN_PASSWORD   ← the release workflow, from repo secrets
//   ~/.pane-signing/pane.p12 and ~/.pane-signing/password        ← your Mac
// Without either it falls back to ad-hoc (fine for trying a build, but permissions won't carry over),
// unless PANE_SIGN_REQUIRED is set, as it is for releases.
//
// The version comes from your newest git tag (v1.2.3 → 1.2.3), so tagging a release is all it takes:
//   git tag v1.2.3 && npm run release
// Fallbacks: PANE_VERSION=1.2.3 npm run package, then package.json's "version".
const { packager } = require('@electron/packager');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const build = path.join(root, 'build');
const pkg = require(path.join(root, 'package.json'));

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function pickVersion() {
  const env = process.env.PANE_VERSION || process.env.SCRAWL_VERSION;
  if (env) return { version: env, from: 'PANE_VERSION' };
  const tag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  if (tag) {
    const ahead = Number(git('rev-list', '--count', `${tag}..HEAD`) || 0);
    const note = ahead ? `tag ${tag}, plus ${ahead} newer commit${ahead === 1 ? '' : 's'} not yet tagged` : `tag ${tag}`;
    return { version: tag.replace(/^v/, ''), from: note };
  }
  return { version: pkg.version, from: 'package.json' };
}

function signingCert() {
  if (process.env.PANE_SIGN_P12) {
    return { p12: Buffer.from(process.env.PANE_SIGN_P12, 'base64'), password: process.env.PANE_SIGN_PASSWORD || '' };
  }
  const dir = path.join(os.homedir(), '.pane-signing');
  try {
    return { p12: fs.readFileSync(path.join(dir, 'pane.p12')), password: fs.readFileSync(path.join(dir, 'password'), 'utf8').trim() };
  } catch {
    return null;
  }
}

// The certificate goes into a throwaway keychain just for this build, so nothing is added to yours.
function sign(app) {
  const cert = signingCert();
  if (!cert) {
    if (process.env.PANE_SIGN_REQUIRED) {
      console.error('No signing certificate (PANE_SIGN_P12 / PANE_SIGN_PASSWORD). Releases must be signed as Pane, or updates lose their permissions.');
      process.exit(1);
    }
    console.warn('No Pane signing certificate found: signing ad-hoc. Permissions given to this build won\'t carry over to the next.');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-sign-'));
  const keychain = path.join(work, 'sign.keychain-db');
  const p12 = path.join(work, 'pane.p12');
  const kcPass = crypto.randomBytes(16).toString('hex');
  let searchList = null;
  const sec = (...args) => execFileSync('security', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    fs.writeFileSync(p12, cert.p12, { mode: 0o600 });
    sec('create-keychain', '-p', kcPass, keychain);
    sec('set-keychain-settings', keychain); // no auto-lock mid-build
    sec('unlock-keychain', '-p', kcPass, keychain);
    sec('import', p12, '-k', keychain, '-P', cert.password, '-T', '/usr/bin/codesign');
    sec('set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPass, keychain);
    // codesign only finds identities in keychains on the search list, so it's on there for the signing only.
    searchList = sec('list-keychains', '-d', 'user').toString().split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
    sec('list-keychains', '-d', 'user', '-s', keychain, ...searchList);
    execFileSync('codesign', ['--force', '--deep', '--keychain', keychain, '--sign', 'Pane Signing', app], { stdio: 'inherit' });
    console.log('Signed as "Pane Signing"');
  } finally {
    if (searchList) try { sec('list-keychains', '-d', 'user', '-s', ...searchList); } catch {}
    try { sec('delete-keychain', keychain); } catch {}
    fs.rmSync(work, { recursive: true, force: true });
  }
}

(async () => {
  const { version, from } = pickVersion();
  if (!/^\d+(\.\d+){0,2}$/.test(version)) {
    console.error(`"${version}" isn't a version like 1.2.3. Tag releases as v1.2.3.`);
    process.exit(1);
  }
  console.log(`Building Pane ${version} (from ${from})`);

  // Only clear what this script makes; build/ also holds the .dmg tooling.
  fs.rmSync(path.join(build, 'Pane.app'), { recursive: true, force: true });
  fs.rmSync(path.join(build, '.tmp'), { recursive: true, force: true });

  require('./native.js').build({ force: true }); // Tweak's helper (native/pane-files)
  require('./uiohook.js').build(); // the key hook, without mouse-move and scroll events

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const [appDir] = await packager({
    dir: root,
    name: 'Pane',
    platform: 'darwin',
    arch,
    out: path.join(build, '.tmp'),
    overwrite: true,
    icon: path.join(root, 'assets', 'icon.icns'),
    appBundleId: 'com.pane.app',
    // Spin drives Spotify and Music with Apple Events; macOS shows this when it asks you to allow that.
    extendInfo: {
      NSAppleEventsUsageDescription: 'Spin plays, skips and sets the volume in your music app.',
      // macOS only shows Wi-Fi network names to apps with Location access (Plugin's "join a network").
      NSLocationUsageDescription: 'Plugin shows the names of Wi-Fi networks nearby so you can join one. Pane never reads where you are.',
      // Plugin's per-app volume taps an app's sound to play it back louder or softer (Core Audio process taps).
      NSAudioCaptureUsageDescription: 'Plugin plays an app’s sound back at the volume you set for it. Pane doesn’t record or keep any of it.',
      NSLocationWhenInUseUsageDescription: 'Plugin shows the names of Wi-Fi networks nearby so you can join one. Pane never reads where you are.',
    },
    appVersion: version, // Finder's "Version" and the About window (CFBundleShortVersionString)
    buildVersion: version, // CFBundleVersion
    ignore: [/^\/(build|assets|scripts|docs|\.claude|\.github)(\/|$)/, /\/prebuilds\/(linux|win32)\//, /^\/native\/.*\.swift$/],
    // Native code can't run from inside app.asar: the key hook's .node files and Tweak's helper sit beside it.
    asar: { unpack: '{**/*.node,**/native/pane-files}' },
    // The running app reports its version from its own package.json, so stamp the same number there.
    afterCopy: [({ buildPath }) => {
      const file = path.join(buildPath, 'package.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      json.version = version;
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
    }],
  });

  fs.renameSync(path.join(appDir, 'Pane.app'), path.join(build, 'Pane.app'));
  fs.rmSync(path.join(build, '.tmp'), { recursive: true, force: true });
  sign(path.join(build, 'Pane.app'));
  console.log(`Built build/Pane.app (version ${version})`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
