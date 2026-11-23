// The Away page of the settings window. Shares S, save(), shake(), swapText() and status with settings.js.

// ---------- keys: a shortcut like ⌃⌘A, or a key tapped twice ----------
const awayWell = document.getElementById('awayWell');
const AWAY_CAPTION = 'Click the keys to change them.';
const awayShortcut = shortcutWell({ tool: 'away', well: awayWell, caption: 'awayCaption', label: 'Away keys', idle: () => AWAY_CAPTION, done: updateAwayStatus });
const cancelAwayListening = awayShortcut.cancel;
modeSeg(document.getElementById('awayMode'), () => S.away.mode, (mode) => saveAway({ mode }).then(() => {
  if (mode === 'shortcut') document.getElementById('awayCaption').textContent = AWAY_CAPTION;
}));

// ---------- on / off ----------
document.getElementById('awayPower').addEventListener('click', (e) => {
  e.currentTarget.blur();
  cancelAwayListening();
  saveAway({ enabled: !S.away.enabled }).then(pollStatus);
});
function updateAwayStatus() {
  if (!S) return;
  const on = S.away.enabled !== false;
  const keys = S.away.keys.symbols.join('');
  const tap = S.away.mode === 'double';
  const power = document.getElementById('awayPower');
  power.classList.toggle('off', !on);
  power.setAttribute('aria-pressed', on);
  swapText(document.getElementById('awayPowerText'), on ? 'Turn off' : 'Turn on');
  document.getElementById('awayPage').classList.toggle('off', !on);
  const ready = on && (tap ? status.listening : status.awayKey);
  document.getElementById('awayStatus').classList.toggle('ready', ready);
  swapText(document.getElementById('awayStatusText'), !on
    ? 'Off.'
    : ready ? (tap ? `On. Tap ${keyText(S.away.key)} twice to step away.` : `On. Press ${keys} to step away.`)
      : tap ? (status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.')
        : `${keys} is taken by another app. Pick other keys.`);
  // A shortcut doesn't need Accessibility, so the ask only shows for double-tap.
  if (!tap) document.querySelector('#awayPage .access')?.classList.remove('open');
  document.getElementById('awayLede').textContent = tap
    ? 'Tap the Away key twice to blur your screen and hide the pointer. Tap it twice again to come back.'
    : 'Press the away keys to blur your screen and hide the pointer. Press them again to come back.';
}

// ---------- the little screen ----------
function renderScreen() {
  const a = S.away;
  const msg = a.message.trim() || Tools.DEFAULT_MESSAGE;
  document.getElementById('miniMsg').textContent = msg;
  const colors = Tools.mood(a.mood).colors;
  document.querySelectorAll('#screen .mblob').forEach((b, i) => b.style.setProperty('--c', colors[i]));
  document.getElementById('miniSince').classList.toggle('gone', !a.showTime);
  // Redraw the icon only when it or the theme changed, so typing a message doesn't restart its animation.
  const look = `${a.icon}/${a.mood}`;
  const cup = document.getElementById('miniCup');
  if (cup.dataset.look !== look) {
    cup.dataset.look = look;
    cup.innerHTML = Tools.glyph('away', 26, { icon: a.icon, mood: a.mood });
    cup.animate([{ transform: 'scale(0.7)' }, { transform: 'none' }], { duration: 420, easing: BOUNCY });
  }
}
document.getElementById('tryAway').addEventListener('click', (e) => { e.currentTarget.blur(); cancelAwayListening(); scrawl.send('away:show'); });

// ---------- message ----------
const msgEl = document.getElementById('message');
msgEl.placeholder = Tools.DEFAULT_MESSAGE;
let msgTimer;
function syncCount() {
  document.getElementById('msgCount').textContent = `${msgEl.value.length}/${msgEl.maxLength}`;
  document.getElementById('resetMsg').classList.toggle('show', msgEl.value !== Tools.DEFAULT_MESSAGE);
}
msgEl.addEventListener('input', () => {
  S.away = { ...S.away, message: msgEl.value };
  renderScreen();
  syncCount();
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => saveAway({ message: msgEl.value }), 300);
});
msgEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); msgEl.blur(); } });
document.getElementById('resetMsg').addEventListener('click', () => {
  msgEl.value = Tools.DEFAULT_MESSAGE;
  msgEl.animate([{ transform: 'scale(0.98)' }, { transform: 'none' }], { duration: 320, easing: BOUNCY });
  saveAway({ message: Tools.DEFAULT_MESSAGE });
});

// ---------- moods ----------
function renderMoods() {
  const box = document.getElementById('moods');
  if (!box.children.length) {
    Tools.MOODS.forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'swatch pop';
      const [c1, c2, c3] = m.colors;
      b.style.setProperty('--c', `conic-gradient(from 200deg, ${c1}, ${c2}, ${c3}, ${c1})`);
      b.style.setProperty('--lipc', `color-mix(in srgb, ${c1} 60%, #2B2733)`);
      b.style.setProperty('--d', `${320 + i * 35}ms`);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', m.name);
      b.title = m.name;
      b.dataset.mood = m.id;
      b.addEventListener('animationend', () => b.classList.remove('pop'), { once: true });
      b.addEventListener('click', () => saveAway({ mood: m.id }));
      box.appendChild(b);
    });
  }
  for (const b of box.children) b.setAttribute('aria-checked', b.dataset.mood === S.away.mood);
}

// ---------- icons: drawn in the chosen theme's colors ----------
function renderIcons() {
  const box = document.getElementById('awayIcons');
  const look = S.away.mood;
  if (box.dataset.look !== look) {
    box.dataset.look = look;
    box.replaceChildren(...Tools.AWAY_ICONS.map((ic) => {
      const b = document.createElement('button');
      b.className = 'icon-pick';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', ic.name);
      b.title = ic.name;
      b.dataset.icon = ic.id;
      b.innerHTML = Tools.glyph('away', 22, { icon: ic.id, mood: look });
      b.addEventListener('click', () => saveAway({ icon: ic.id }));
      return b;
    }));
  }
  for (const b of box.children) b.setAttribute('aria-checked', b.dataset.icon === S.away.icon);
  const chosen = Tools.AWAY_ICONS.find((ic) => ic.id === S.away.icon) || Tools.AWAY_ICONS[0];
  document.getElementById('iconName').textContent = chosen.name;
}

// ---------- switches ----------
for (const id of ['showTime', 'hidePointer']) {
  document.getElementById(id).addEventListener('click', () => saveAway({ [id]: !S.away[id] }));
}

function saveAway(patch) {
  return save({ away: { ...S.away, ...patch } });
}

let awayStarted = false;
function updateAway() {
  if (!S?.away) return;
  if (!awayStarted) {
    awayStarted = true;
    awayShortcut.render(S.away.keys.symbols, { pop: true });
    awayWell.querySelectorAll('.keycap').forEach((k, i) => k.style.setProperty('--d', `${260 + i * 60}ms`));
  }
  if (document.activeElement !== msgEl && msgEl.value !== S.away.message) msgEl.value = S.away.message;
  syncCount();
  renderMoods();
  renderIcons();
  document.getElementById('showTime').setAttribute('aria-checked', S.away.showTime);
  document.getElementById('hidePointer').setAttribute('aria-checked', S.away.hidePointer);
  renderScreen();
  updateAwayStatus();
}
