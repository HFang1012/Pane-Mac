// Jot's two windows, in one page: the note you write (opens at the pointer) and the reminder that comes
// back when its time is up (top left). Which one comes from the address: ?mode=compose or ?mode=toast&id=…
const q = new URLSearchParams(location.search);
const MODE = q.get('mode');
const $ = (id) => document.getElementById(id);
const BOUNCY = getComputedStyle(document.documentElement).getPropertyValue('--bouncy').trim();
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const span = (min) => (min < 60 ? `${min} min` : min % 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min / 60} hr`);
const shake = (el) => el.animate([{ translate: '0' }, { translate: '-6px' }, { translate: '5px' }, { translate: '-3px' }, { translate: '0' }], { duration: 340, easing: 'ease-out' });

// The window is sized to its card, so it never catches clicks far from what you see.
function fitWindow(channel) {
  const wrap = document.querySelector('.wrap');
  let last = 0;
  new ResizeObserver(() => {
    const h = Math.ceil(wrap.getBoundingClientRect().height);
    if (h !== last) { last = h; scrawl.send(channel, h); }
  }).observe(wrap);
}

if (MODE === 'toast') startToast();
else startCompose();

// ---------- writing a note ----------
async function startCompose() {
  document.body.className = 'compose';
  document.body.append($('composeTpl').content.cloneNode(true));
  const init = await scrawl.invoke('jot:init');
  const text = $('text');
  $('tag').innerHTML = `${Tools.glyph('jot', 15)}New note`;
  fitWindow('jot:fit');

  // Text grows with what you write, up to a point, then scrolls.
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(190, Math.max(84, text.scrollHeight))}px`; };
  text.addEventListener('input', () => { grow(); calm(); });
  setTimeout(() => text.focus(), 60);

  // ---------- the timer ----------
  const CHOICES = [5, 15, 30, 60, 180];
  const pills = $('pills'), thumb = $('thumb');
  let minutes = init.last || 15;
  let custom = !CHOICES.includes(minutes);
  CHOICES.forEach((m) => {
    const b = document.createElement('button');
    b.className = 'pill';
    b.setAttribute('role', 'radio');
    b.dataset.min = m;
    b.textContent = m < 60 ? `${m}m` : `${m / 60}h`;
    b.setAttribute('aria-label', span(m));
    b.addEventListener('click', () => { custom = false; pick(m); });
    pills.append(b);
  });
  // Your own number of minutes.
  const own = document.createElement('label');
  own.className = 'pill custom';
  own.setAttribute('role', 'radio');
  own.innerHTML = '<input id="own" type="number" min="1" max="1440" placeholder="—" aria-label="Minutes"><span>m</span>';
  pills.append(own);
  const ownIn = own.querySelector('input');
  if (custom) ownIn.value = minutes;
  own.addEventListener('pointerdown', () => { custom = true; requestAnimationFrame(() => ownIn.focus()); });
  ownIn.addEventListener('focus', () => { custom = true; if (!ownIn.value) ownIn.value = minutes; ownIn.select(); pick(Number(ownIn.value) || minutes); });
  ownIn.addEventListener('input', () => { const v = Math.round(Number(ownIn.value)); if (v >= 1 && v <= 1440) pick(v); });
  ownIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.metaKey) { e.preventDefault(); text.focus(); } });

  function pick(m) {
    minutes = Math.max(1, Math.min(1440, m));
    const sel = custom ? own : pills.querySelector(`.pill[data-min="${minutes}"]`) || own;
    for (const p of pills.querySelectorAll('.pill')) p.setAttribute('aria-checked', p === sel);
    thumb.style.translate = `${sel.offsetLeft}px 0`;
    thumb.style.width = `${sel.offsetWidth}px`;
    // "at 3:57 PM", rolling in when it changes.
    const when = $('when'), next = `at ${clock(Date.now() + minutes * 60000)}`;
    if (when.textContent !== next) {
      when.textContent = next;
      when.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: BOUNCY });
    }
  }
  thumb.style.transition = 'none';
  requestAnimationFrame(() => { pick(minutes); requestAnimationFrame(() => { thumb.style.transition = ''; }); });
  setInterval(() => pick(minutes), 15000); // keep "at 3:57 PM" honest while the note is open

  // ---------- a screenshot ----------
  let image = null; // { path, url }
  function setImage(img) {
    // A new one replaces the old, and a removed one is deleted, so no stray pictures pile up.
    if (image && image.path !== img?.path) scrawl.send('jot:dropShot', image.path);
    image = img;
    $('shot').hidden = !img;
    $('shotLabel').textContent = img ? 'Retake' : 'Screenshot';
    calm();
    if (!img) return;
    $('shotImg').src = img.url;
    const s = $('shot');
    s.classList.remove('flash'); void s.offsetWidth; s.classList.add('flash');
    s.style.animation = 'none'; void s.offsetWidth; s.style.animation = '';
  }
  $('shotX').addEventListener('click', () => {
    $('shot').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.7)' }], { duration: 180, easing: 'ease-in' })
      .finished.then(() => { setImage(null); text.focus(); });
  });
  const done = (btn) => { btn.classList.remove('done'); void btn.offsetWidth; btn.classList.add('done'); };
  $('shotBtn').addEventListener('click', async () => {
    const btn = $('shotBtn');
    btn.classList.add('busy');
    const r = await scrawl.invoke('jot:shot');
    btn.classList.remove('busy');
    if (r?.image) { setImage(r.image); done(btn); }
    else if (r?.denied) say('Allow Screen Recording for Pane first.', true);
    text.focus();
  });

  // ---------- the line beside Send ----------
  const HINT = '<kbd>⌘</kbd><kbd>↩</kbd> to send';
  let hintT = 0;
  let sure = false; // Esc pressed once on a note with something in it
  function say(msg, warn) {
    const h = $('hint');
    h.textContent = msg;
    h.classList.toggle('warn', !!warn);
    clearTimeout(hintT);
    hintT = setTimeout(calm, 2400);
  }
  function calm() {
    const h = $('hint');
    if (h.innerHTML !== HINT) { h.innerHTML = HINT; h.classList.remove('warn'); }
    sure = false;
    $('send').classList.toggle('empty', !text.value.trim() && !image);
  }
  calm();

  // ---------- send it off ----------
  let leaving = false;
  async function send() {
    if (leaving) return;
    const body = text.value.trim();
    if (!body && !image) { shake($('send')); say('Write something first.', true); text.focus(); return; }
    leaving = true;
    // The plane glides out of the button (CSS), then the card eases away.
    document.body.classList.add('sent');
    await new Promise((res) => setTimeout(res, 700));
    scrawl.invoke('jot:send', { text: body, minutes, image: image?.path || null });
  }
  $('send').addEventListener('click', send);

  // Esc throws the note away. With something written, it asks once first.
  function toss() {
    if (leaving) return;
    if ((text.value.trim() || image) && !sure) { sure = true; say('Press Esc again to throw it away.', true); shake($('card')); return; }
    leaving = true;
    document.body.classList.add('gone');
    setTimeout(() => scrawl.send('jot:cancel'), 280);
  }
  $('close').addEventListener('click', () => { sure = true; toss(); });
  addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); toss(); }
  });
  // Main asks the note to leave (Jot turned off, Pane quitting): it just goes.
  scrawl.on('jot:leave', () => { leaving = true; document.body.classList.add('gone'); });
}

// ---------- a reminder, back in the corner ----------
async function startToast() {
  document.body.className = 'toast';
  document.body.append($('toastTpl').content.cloneNode(true));
  const id = q.get('id');
  const n = await scrawl.invoke('jot:note', id);
  if (!n) return;
  fitWindow('jot:toastFit');
  $('tText').textContent = n.text;
  $('tTitle').textContent = n.snoozed ? 'Back from snooze' : 'Time’s up';
  $('tSub').textContent = `Jotted at ${clock(n.made)}`;
  $('tSnoozeText').textContent = `${n.snoozeFor} min`;
  $('tSnooze').title = `Snooze for ${span(n.snoozeFor)}`;
  $('tCopy').hidden = !n.text;
  if (n.image) { $('tShotWrap').hidden = false; $('tShotImg').src = n.image; }
  $('tShotX').addEventListener('click', () => {
    $('tShotWrap').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.7)' }], { duration: 180, easing: 'ease-in' })
      .finished.then(() => { $('tShotWrap').hidden = true; scrawl.send('jot:removeShot', id); });
  });

  let going = false;
  const leave = (cls, channel) => {
    if (going) return;
    going = true;
    document.body.classList.add(cls);
    setTimeout(() => scrawl.send(channel, id), cls === 'snooze' ? 480 : 340);
  };
  $('tDone').addEventListener('click', () => leave('leave', 'jot:done'));
  $('tClose').addEventListener('click', () => leave('leave', 'jot:done'));
  $('tSnooze').addEventListener('click', () => leave('snooze', 'jot:snooze'));
  $('tShot').addEventListener('click', () => scrawl.send('jot:openShot', id));
  $('tCopy').addEventListener('click', () => {
    scrawl.send('jot:copy', id);
    const s = $('tCopy').querySelector('.swap');
    s.classList.add('out');
    setTimeout(() => { s.textContent = 'Copied'; s.classList.remove('out'); }, 140);
    setTimeout(() => { s.classList.add('out'); setTimeout(() => { s.textContent = 'Copy'; s.classList.remove('out'); }, 140); }, 1600);
  });
  scrawl.on('jot:leave', () => leave('leave', 'jot:gone'));
}
