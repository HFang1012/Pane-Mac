// The Tweak page of the settings window. Shares S, save(), swapText(), status and the held-key chooser with
// settings.js (the double-tap well is one of its wells).
function saveTweak(patch) {
  return save({ tweak: { ...S.tweak, ...patch } });
}
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
  const ready = on && status.listening;
  document.getElementById('tweakStatus').classList.toggle('ready', ready);
  swapText(document.getElementById('tweakStatusText'), !on
    ? 'Off.'
    : ready ? `On. Press ${keyText(S.tweak.key)} twice, then click a file.`
      : status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
}
function updateTweak() {
  if (!S?.tweak) return;
  document.getElementById('tweakCopy').setAttribute('aria-checked', !!S.tweak.copy);
  document.getElementById('tweakTrash').setAttribute('aria-checked', S.tweak.trash !== false);
  updateTweakStatus();
}
