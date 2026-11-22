// The Away screen: one per display. The main process blurs and fades the window; this page draws
// the drifting color, the note, and how long you've been gone.
const $ = (id) => document.getElementById(id);
const primary = new URLSearchParams(location.search).get('primary') === '1';

// Blob placement: spread around the screen, each drifting its own way at its own pace.
const SPOTS = [
  { x: '18%', y: '24%', dx: '9vw', dy: '6vh', t: '34s', delay: '-4s' },
  { x: '82%', y: '30%', dx: '-8vw', dy: '9vh', t: '41s', delay: '-17s' },
  { x: '52%', y: '86%', dx: '6vw', dy: '-8vh', t: '38s', delay: '-9s' },
  { x: '12%', y: '88%', dx: '7vw', dy: '-5vh', t: '46s', delay: '-26s' },
];

function since(t) {
  const time = new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return `Away since ${time}`;
  const span = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr${mins >= 120 ? 's' : ''}${mins % 60 ? ` ${mins % 60} min` : ''}`;
  return `Away since ${time} · ${span}`;
}

scrawl.invoke('away:init').then((a) => {
  document.body.classList.toggle('no-pointer', !!a.hidePointer);
  $('cup').innerHTML = Tools.glyph('away', 64);
  $('msg').textContent = (a.message || '').trim() || Tools.DEFAULT_MESSAGE;

  const colors = a.mood.colors;
  $('blobs').innerHTML = SPOTS.map((s, i) =>
    `<div class="blob" style="--c:${colors[i % colors.length]};--x:${s.x};--y:${s.y};--dx:${s.dx};--dy:${s.dy};--t:${s.t};--delay:${s.delay}"></div>`).join('');

  if (a.showTime) {
    const el = $('since');
    el.hidden = false;
    const tick = () => { $('sinceText').textContent = since(a.since); };
    tick();
    setInterval(tick, 15000);
  }

  // How to come back: briefly, on the screen you were on. A preview closes with any key or click.
  if (primary) {
    const hint = $('hint');
    hint.innerHTML = a.preview
      ? 'This is a preview. Click or press any key to close it.'
      : a.mode === 'double'
        ? `Tap <kbd>${(a.key.keys || [a.key]).map((k) => k.symbol).join('</kbd><kbd>')}</kbd> twice when you’re back.`
        : `Press <kbd>${a.keys.symbols.join('</kbd><kbd>')}</kbd> when you’re back.`;
    setTimeout(() => hint.classList.add('show'), 700);
    if (!a.preview) setTimeout(() => hint.classList.remove('show'), 4200);
  }
  if (a.preview) {
    const close = () => scrawl.send('away:dismiss');
    addEventListener('keydown', close);
    addEventListener('mousedown', close);
  }
});

scrawl.on('away:leave', () => document.body.classList.add('leaving'));
