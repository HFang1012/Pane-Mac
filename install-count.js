// Counts each Mac once, the first time Pane opens there, so we know how many people use it.
// Nothing about you or your Mac is sent: one anonymous hit to GoatCounter, with no ID, no version
// and nothing to recognise you by. Updates never count, and neither do reinstalls, because the
// marker file stays in Pane's settings folder.
//
//   app/install   Pane opened for the first time on this Mac account
//   app/existing  someone who had Pane (or Scrawl) before this counting existed, counted once
//
// If the hit doesn't get through (offline, blocked), it's tried again next time Pane opens.
// Development runs never count. Set PANE_NO_COUNT=1 to turn it off.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const ENDPOINT = 'https://pane-mac.goatcounter.com/count';
const TITLES = { install: 'New install', existing: 'Already had Pane' };

function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// fresh: there were no settings on this Mac before Pane opened (no Pane, no old Scrawl).
async function countOnce({ dir, fresh, packaged, endpoint = ENDPOINT }) {
  if (!packaged || process.env.PANE_NO_COUNT) return 'skipped';
  const file = path.join(dir, 'counted.json');
  let marker = readMarker(file);
  if (marker?.sent) return 'already';
  if (!marker) {
    // Decide the kind now and keep it: by the next launch there are settings, so it can't be told again.
    marker = { kind: fresh ? 'install' : 'existing', sent: false };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker));
  }
  const query = new URLSearchParams({ p: `app/${marker.kind}`, t: TITLES[marker.kind], e: 'true', rnd: Math.random().toString(36).slice(2) });
  try {
    const res = await net.fetch(`${endpoint}?${query}`, { cache: 'no-store' });
    if (!res.ok) return `failed ${res.status}`;
    fs.writeFileSync(file, JSON.stringify({ ...marker, sent: true, at: new Date().toISOString() }));
    return 'sent';
  } catch (err) {
    return `failed ${err.message}`;
  }
}

module.exports = { countOnce };
