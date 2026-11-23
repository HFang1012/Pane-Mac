// The Debug page of the settings window. Shares S, save(), swapText(), status, keyText() and the held-key
// chooser with settings.js (the double-tap / hold well is one of its wells).
function saveDebug(patch) {
  return save({ debug: { ...S.debug, ...patch } });
}
const DEBUG_CAPTIONS = {
  double: 'Click the key to change it. Tap it twice, quickly.',
  hold: 'Click the key to change it. Hold it down for a moment.',
  shortcut: 'Click the keys to change them.',
};
const debugShortcut = shortcutWell({ tool: 'debug', well: document.getElementById('debugWell'), caption: 'debugCaption', label: 'Debug keys', idle: () => DEBUG_CAPTIONS.shortcut });
modeSeg(document.getElementById('debugMode'), () => S.debug.mode, (mode) => saveDebug({ mode }).then(() => {
  document.getElementById('debugCaption').textContent = DEBUG_CAPTIONS[S.debug.mode];
}));
document.getElementById('debugPower').addEventListener('click', (e) => {
  e.currentTarget.blur();
  debugShortcut.cancel();
  saveDebug({ enabled: !S.debug.enabled }).then(pollStatus);
});
document.getElementById('tryDebug').addEventListener('click', (e) => { e.currentTarget.blur(); scrawl.send('debug:try'); });
document.getElementById('debugConfirm').addEventListener('click', () => saveDebug({ confirm: !S.debug.confirm }));
// Pills for choices that aren't numbers (size, where it opens…). Refresh is a number, kept as one.
document.querySelectorAll('#debugPage .picks').forEach((group) => {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    b.blur();
    const key = group.dataset.key;
    const v = key === 'refresh' ? Number(b.dataset.v) : b.dataset.v;
    if (S.debug[key] !== v) saveDebug({ [key]: v });
  });
});
// The gear on the panel brings you here.
scrawl.on('page:show', (id) => { if (typeof showPage === 'function') showPage(id, true); });

const debugTrigger = () => (S.debug.mode === 'shortcut' ? S.debug.keys.symbols.join('')
  : S.debug.mode === 'hold' ? `and hold ${keyText(S.debug.key)}` : `${keyText(S.debug.key)} twice`);
function updateDebugStatus() {
  if (!S?.debug) return;
  const on = S.debug.enabled !== false;
  const power = document.getElementById('debugPower');
  power.classList.toggle('off', !on);
  power.setAttribute('aria-pressed', on);
  swapText(document.getElementById('debugPowerText'), on ? 'Turn off' : 'Turn on');
  document.getElementById('debugPage').classList.toggle('off', !on);
  const shortcut = S.debug.mode === 'shortcut';
  const ready = on && (shortcut ? status.debugKey : status.listening);
  document.getElementById('debugStatus').classList.toggle('ready', ready);
  swapText(document.getElementById('debugStatusText'), !on
    ? 'Off.'
    : ready ? `On. Press ${debugTrigger()} to check your Mac.`
      : shortcut ? `${S.debug.keys.symbols.join('')} is taken by another app. Pick other keys.`
        : status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
  if (shortcut) document.querySelector('#debugPage .access')?.classList.remove('open');
}
let debugStarted = false;
function updateDebug() {
  if (!S?.debug) return;
  if (!debugStarted) {
    debugStarted = true;
    debugShortcut.render(S.debug.keys.symbols, { pop: true });
    document.getElementById('ddGlyph').innerHTML = Tools.glyph('debug', 13);
    document.getElementById('debugCaption').textContent = DEBUG_CAPTIONS[S.debug.mode];
  }
  const mode = S.debug.mode;
  document.getElementById('debugLede').textContent = `${{ double: 'Double-tap the Debug key', hold: 'Hold the Debug key', shortcut: 'Press the Debug keys' }[mode]} and a small panel opens over whatever you’re doing. It shows what’s slowing things down or draining your battery, and fixes you can click.`;
  document.getElementById('debugKeyLabel').textContent = mode === 'hold' ? 'Hold it' : 'Tap twice';
  document.querySelectorAll('#debugPage .picks').forEach((group) => {
    const v = String(S.debug[group.dataset.key]);
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === v));
  });
  document.getElementById('debugConfirm').setAttribute('aria-checked', S.debug.confirm !== false);
  updateDebugStatus();
}

// ---------- right now: does this Mac need debugging? ----------
// Asked while the Debug page is showing (each look runs a few quick commands), every 10 seconds.
async function checkDebugHealth() {
  if (document.getElementById('debugPage').hidden || document.hidden) return;
  const h = await scrawl.invoke('debug:health');
  if (!h) return;
  document.getElementById('debugHealth').className = `row dhealth ${h.level}`;
  document.getElementById('debugHealthScore').textContent = h.score;
  document.getElementById('debugHealthScore').title = 'Health, out of 100';
  document.getElementById('debugHealthText').textContent = `${h.answer}${h.reasons.length ? ` ${h.reasons.slice(0, 2).join(', ')}.` : ''}`;
}
setInterval(checkDebugHealth, 10000);
new MutationObserver(() => checkDebugHealth()).observe(document.getElementById('debugPage'), { attributes: true, attributeFilter: ['hidden'] });
