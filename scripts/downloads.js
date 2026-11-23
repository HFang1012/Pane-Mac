// How many people got Pane, from GitHub's own download counts on each release.
//
//   npm run downloads
//
// Pane.dmg is fetched by the website's button, by install.sh and by the updater when it can't patch,
// so it's mostly new installs. The .patch files are only fetched by the updater, so they're updates.
// Website visits and button clicks are on GoatCounter: https://pane-mac.goatcounter.com
const REPO = process.env.PANE_REPO || 'HFang1012/Pane-Mac';

async function releases() {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pane-downloads' },
    });
    if (!res.ok) throw new Error(`GitHub said ${res.status} ${res.statusText}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

(async () => {
  const list = await releases();
  const rows = list.map((r) => {
    const sum = (test) => r.assets.filter((a) => test(a.name)).reduce((n, a) => n + a.download_count, 0);
    return {
      version: r.tag_name.replace(/^v/, ''),
      date: (r.published_at || r.created_at || '').slice(0, 10),
      dmg: sum((n) => n.toLowerCase().endsWith('.dmg')),
      updates: sum((n) => n.endsWith('.patch')),
    };
  });
  const total = (k) => rows.reduce((n, r) => n + r[k], 0);
  const pad = (v, w) => String(v).padStart(w);

  console.log(`Downloads for ${REPO}\n`);
  console.log(`${'version'.padEnd(10)} ${'released'.padEnd(10)} ${pad('Pane.dmg', 9)} ${pad('updates', 8)}`);
  for (const r of rows) console.log(`${r.version.padEnd(10)} ${r.date.padEnd(10)} ${pad(r.dmg, 9)} ${pad(r.updates, 8)}`);
  console.log(`\nPane.dmg (mostly new installs): ${total('dmg')}`);
  console.log(`Updates by patch:               ${total('updates')}`);
  console.log(`Releases:                       ${rows.length}`);
  console.log('\nThese count every download, bots and repeats too. One per person:');
  console.log('  https://hfang1012.github.io/Pane-Mac/stats/  (npm run stats)');
})().catch((err) => {
  console.error(`Couldn't read the download counts: ${err.message}`);
  process.exit(1);
});
