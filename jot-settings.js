// The Jot page of the settings window. Shares S, save(), shake(), swapText(), status and the held-key
// chooser with settings.js (the double-tap well is one of its wells), and mainKey() / held() with
// away-settings.js (the shortcut well reads keys the same way Away's does).
const jotWell = document.getElementById('jotWell');
const jotSeg = document.getElementById('jotMode');

function saveJot(patch) {
  return save({ jot: { ...S.jot, ...patch } });
}

// ---------- double-tap, or a shortcut ----------
const jotCaptionText = () => (S.jot.mode === 'shortcut' ? 'Click the keys to change them.' : JOT_CAPTION);
const jotShortcut = shortcutWell({ tool: 'jot', well: jotWell, caption: 'jotCaption', label: 'Jot keys', idle: jotCaptionText });
const cancelJotListening = jotShortcut.cancel;
modeSeg(jotSeg, () => S.jot.mode, (mode) => saveJot({ mode }).then(() => {
  document.getElementById('jotCaption').textContent = jotCaptionText();
}));

// ---------- on / off ----------
document.getElementById('jotPower').addEventListener('click', (e) => {
  e.currentTarget.blur();
  cancelJotListening();
  saveJot({ enabled: !S.jot.enabled }).then(pollStatus);
});
const jotTrigger = () => (S.jot.mode === 'shortcut' ? S.jot.keys.symbols.join('') : `${keyText(S.jot.key)} twice`);
function updateJotStatus() {
  if (!S?.jot) return;
  const on = S.jot.enabled !== false;
  const power = document.getElementById('jotPower');
  power.classList.toggle('off', !on);
  power.setAttribute('aria-pressed', on);
  swapText(document.getElementById('jotPowerText'), on ? 'Turn off' : 'Turn on');
  document.getElementById('jotPage').classList.toggle('off', !on);
  const shortcut = S.jot.mode === 'shortcut';
  const ready = on && (shortcut ? status.jotKey : status.listening);
  document.getElementById('jotStatus').classList.toggle('ready', ready);
  swapText(document.getElementById('jotStatusText'), !on
    ? 'Off.'
    : ready ? `On. Press ${jotTrigger()} for a note.`
      : shortcut ? `${S.jot.keys.symbols.join('')} is taken by another app. Pick other keys.`
        : status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
  // A shortcut doesn't need Accessibility, so the ask only shows for double-tap.
  if (shortcut) document.querySelector('#jotPage .access')?.classList.remove('open');
}

// ---------- coming up ----------
let jotNotes = [];
const until = (due) => {
  const m = Math.round((due - Date.now()) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `in ${h} hr ${r} min` : `in ${h} hr`;
};
function renderJotList(animate = false) {
  const box = document.getElementById('jotList');
  const count = document.getElementById('jotCount');
  count.textContent = jotNotes.length ? `${jotNotes.length} on ${jotNotes.length === 1 ? 'its' : 'their'} way back.` : 'Notes on their way back.';
  if (!jotNotes.length) {
    if (!box.querySelector('.jempty')) box.innerHTML = `<div class="jempty">Nothing yet. Press <b>${jotTrigger()}</b> to jot one down.</div>`;
    else box.querySelector('.jempty b').textContent = jotTrigger();
    return;
  }
  // Keep rows that are still there (so they don't pop again), add new ones, drop the rest.
  box.querySelector('.jempty')?.remove();
  const have = new Map([...box.querySelectorAll('.jitem')].map((el) => [el.dataset.id, el]));
  jotNotes.forEach((n, i) => {
    let el = have.get(n.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'jitem';
      el.setAttribute('role', 'listitem');
      el.dataset.id = n.id;
      el.style.setProperty('--d', animate ? `${i * 40}ms` : '0ms');
      el.innerHTML = '<b></b><small></small><button aria-label="Cancel this note"><svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>';
      el.querySelector('button').addEventListener('click', () => {
        el.classList.add('out');
        setTimeout(() => scrawl.send('jot:cancel-note', n.id), 220);
      });
    }
    const label = n.text ? n.text.split('\n')[0] : '';
    el.querySelector('b').innerHTML = '';
    el.querySelector('b').append(label || '');
    if (n.image) el.querySelector('b').insertAdjacentHTML('beforeend', label ? ' <i>+ picture</i>' : '<i>A screenshot</i>');
    el.querySelector('small').textContent = n.showing ? 'on screen' : until(n.due);
    el.classList.toggle('now', n.showing);
    box.append(el); // in order of when they're due
    have.delete(n.id);
  });
  for (const el of have.values()) el.remove();
}
scrawl.on('jot:changed', (list) => { jotNotes = list; renderJotList(true); });
setInterval(() => { if (jotNotes.length) renderJotList(); }, 20000);

document.getElementById('jotSound').addEventListener('click', () => saveJot({ sound: !S.jot.sound }));
document.getElementById('tryJot').addEventListener('click', (e) => { e.currentTarget.blur(); cancelJotListening(); scrawl.send('jot:try'); });

let jotStarted = false;
function updateJot() {
  if (!S?.jot) return;
  if (!jotStarted) {
    jotStarted = true;
    jotShortcut.render(S.jot.keys.symbols, { pop: true });
    scrawl.invoke('jot:list').then((list) => { jotNotes = list; renderJotList(true); });
  }
  const shortcut = S.jot.mode === 'shortcut';
  document.getElementById('jotLede').textContent = shortcut
    ? 'Press the Jot keys and a note opens at your pointer. Pick a timer, send it off, and it comes back in the top-left corner when it’s time.'
    : 'Double-tap the Jot key and a note opens at your pointer. Pick a timer, send it off, and it comes back in the top-left corner when it’s time.';
  document.getElementById('jotSound').setAttribute('aria-checked', S.jot.sound);
  renderJotList();
  updateJotStatus();
}
