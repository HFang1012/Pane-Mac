// The Tweak page of the settings window. Shares S, save(), swapText(), status and the held-key chooser with
// settings.js (the double-tap well is one of its wells).
function saveTweak(patch) {
  return save({ tweak: { ...S.tweak, ...patch } });
}
// Double-tap the Tweak key, or press a shortcut.
const tweakCaptionText = () => (S.tweak.mode === 'shortcut' ? 'Click the keys to change them.' : TWEAK_CAPTION);
const tweakShortcut = shortcutWell({ tool: 'tweak', well: document.getElementById('tweakWell'), caption: 'tweakCaption', label: 'Tweak keys', idle: tweakCaptionText });
modeSeg(document.getElementById('tweakMode'), () => S.tweak.mode, (mode) => saveTweak({ mode }).then(() => {
  document.getElementById('tweakCaption').textContent = tweakCaptionText();
}));
document.getElementById('tweakPower').addEventListener('click', (e) => {
  e.currentTarget.blur();
  saveTweak({ enabled: !S.tweak.enabled }).then(pollStatus);
});
document.getElementById('tweakCopy').addEventListener('click', () => saveTweak({ copy: !S.tweak.copy }));
document.getElementById('tweakTrash').addEventListener('click', () => saveTweak({ trash: !S.tweak.trash }));
document.getElementById('tweakChoose').addEventListener('click', (e) => { e.currentTarget.blur(); scrawl.send('tweak:choose'); });
document.getElementById('tryTweak').addEventListener('click', (e) => { e.currentTarget.blur(); scrawl.send('tweak:try'); });

function updateTweakStatus() {
  if (!S?.tweak) return;
  const on = S.tweak.enabled !== false;
  const power = document.getElementById('tweakPower');
  power.classList.toggle('off', !on);
  power.setAttribute('aria-pressed', on);
  swapText(document.getElementById('tweakPowerText'), on ? 'Turn off' : 'Turn on');
  document.getElementById('tweakPage').classList.toggle('off', !on);
  // Pointing at files needs Accessibility either way; a shortcut also has to be free.
  const shortcut = S.tweak.mode === 'shortcut';
  const keys = S.tweak.keys.symbols.join('');
  const ready = on && status.listening && (!shortcut || status.tweakKey);
  document.getElementById('tweakStatus').classList.toggle('ready', ready);
  swapText(document.getElementById('tweakStatusText'), !on
    ? 'Off.'
    : ready ? `On. ${shortcut ? `Press ${keys}` : `Press ${keyText(S.tweak.key)} twice`}, then click a file.`
      : !status.listening ? (status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.')
        : `${keys} is taken by another app. Pick other keys.`);
}
let tweakStarted = false;
function updateTweak() {
  if (!S?.tweak) return;
  if (!tweakStarted) { tweakStarted = true; tweakShortcut.render(S.tweak.keys.symbols, { pop: true }); }
  document.getElementById('tweakLede').textContent = `${S.tweak.mode === 'shortcut' ? 'Press the Tweak keys' : 'Double-tap the Tweak key'} and point at a file on your desktop or in Finder. Click it to crop, trim, cut or rewrite it, change its type, and save it back.`;
  document.getElementById('tweakCopy').setAttribute('aria-checked', !!S.tweak.copy);
  document.getElementById('tweakTrash').setAttribute('aria-checked', S.tweak.trash !== false);
  updateTweakStatus();
}
