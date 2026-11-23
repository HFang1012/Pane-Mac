// Pane's update sheet, and the button in the bottom-left corner that brings it back after Later or Skip.
// The main process (updater.js) owns the state; this only draws it and passes the clicks back.
const updEl = document.getElementById('upd');
const updCorner = document.getElementById('updCorner');
const $u = (id) => document.getElementById(id);
let upd = { status: 'idle' };
let updFocus = null;
// esc() (HTML escaping) comes from spin-settings.js, loaded earlier on the page.

function renderNotes(notes) {
  // A commit title like "Spin: picking a song…" reads better with its area in bold.
  const item = (t) => {
    const m = /^([A-Z][\w ]{1,18}):\s+(.*)$/.exec(t);
    return `<li>${m ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(t)}</li>`;
  };
  return notes.map((n, i) =>
    `<section><h3>Pane ${esc(n.version)}${i === 0 ? ' <small>Newest</small>' : ''}</h3><ul>${n.items.map(item).join('')}</ul></section>`).join('');
}

function renderUpdate(s) {
  const prev = upd;
  upd = s;
  const busy = s.status === 'downloading' || s.status === 'installing';
  const has = !!s.version;

  // Title, line under it, and the changelog.
  const title = {
    checking: 'Checking for updates…',
    current: 'Pane is up to date',
    available: `Pane ${s.version} is here`,
    downloading: `Updating to ${s.version}`,
    installing: `Updating to ${s.version}`,
    error: has ? `Pane ${s.version} is here` : 'Couldn’t check for updates',
  }[s.status] || 'Updates';
  $u('updTitle').textContent = title;
  $u('updSub').textContent = s.status === 'current' ? `You have the newest version, ${s.current}.`
    : has ? `You have ${s.current}. Here’s what’s new.` : s.status === 'checking' ? 'Asking GitHub for the newest version.' : '';
  if (s.notes !== prev.notes) $u('updNotes').innerHTML = has ? renderNotes(s.notes || []) : '';

  // Progress and messages.
  updEl.classList.toggle('busy', busy);
  updEl.classList.toggle('installing', s.status === 'installing');
  updEl.classList.toggle('error', s.status === 'error');
  $u('updBar').style.setProperty('--p', s.progress || 0);
  $u('updMsg').textContent = s.status === 'downloading' ? `Downloading… ${Math.round((s.progress || 0) * 100)}%`
    : s.status === 'installing' ? 'Putting it in place. Pane will reopen in a moment.'
    : s.status === 'error' ? s.error : '';

  // Buttons.
  const go = $u('updGo');
  go.hidden = s.status === 'checking';
  go.disabled = busy;
  go.textContent = s.status === 'current' ? 'Done' : busy ? 'Updating…' : s.status === 'error' ? 'Try Again' : 'Update and Restart';
  $u('updLater').hidden = !has || busy;
  $u('updSkip').hidden = !has || busy;
  $u('updClose').hidden = busy;

  // Open or close the sheet.
  const wasOpen = updEl.classList.contains('open');
  if (s.open && !wasOpen) {
    if (typeof closeDemo === 'function') closeDemo();
    if (typeof closeSwitcher === 'function') closeSwitcher();
    updFocus = document.activeElement;
    updEl.classList.add('open');
    // Focus the sheet itself, not a button: Return or Space alone never starts an update.
    requestAnimationFrame(() => updEl.querySelector('.upd-sheet').focus({ preventScroll: true }));
  } else if (!s.open && wasOpen) {
    updEl.classList.remove('open');
    updFocus?.focus?.({ preventScroll: true });
  }

  // While an update is waiting and the sheet is closed, the corner button offers it.
  const waiting = has && !s.open && ['available', 'error', 'downloading', 'installing'].includes(s.status);
  $u('updCornerText').textContent = busy ? 'Updating…' : `Update to ${s.version}`;
  updCorner.classList.toggle('show', waiting);
  updCorner.tabIndex = waiting ? 0 : -1;
}

function dismissUpdate() {
  if (upd.status === 'downloading' || upd.status === 'installing') return;
  scrawl.send('update:later');
}

$u('updGo').addEventListener('click', () => {
  if (upd.status === 'current') return scrawl.send('update:later');
  if (upd.status === 'error' && !upd.version) return scrawl.send('update:check');
  scrawl.send('update:install');
});
$u('updLater').addEventListener('click', dismissUpdate);
$u('updClose').addEventListener('click', dismissUpdate);
$u('updSkip').addEventListener('click', () => scrawl.send('update:skip'));
updCorner.addEventListener('click', () => scrawl.send('update:open'));
// The title bar button always asks GitHub again (and opens the sheet to show what it finds).
$u('checkUpdates').addEventListener('click', (e) => { e.currentTarget.blur(); scrawl.send('update:check'); });
updEl.addEventListener('pointerdown', (e) => { if (e.target === updEl) dismissUpdate(); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && updEl.classList.contains('open')) { e.preventDefault(); dismissUpdate(); }
});

scrawl.on('update:state', renderUpdate);
scrawl.invoke('update:get').then(renderUpdate);
