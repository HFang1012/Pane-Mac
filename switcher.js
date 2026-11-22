// The tool button in the top-right corner: pick which of Pane's tools the window shows.
const switchBtn = document.getElementById('switchBtn');
const switchMenu = document.getElementById('switchMenu');
const PAGES = { scrawl: document.getElementById('page'), away: document.getElementById('awayPage'), spin: document.getElementById('spinPage'), jot: document.getElementById('jotPage'), tweak: document.getElementById('tweakPage') };
let currentPage = null;

// Each tool in the menu: its glyph on a tile, name, one line about it, and a tick on the open one.
Tools.TOOLS.forEach((t, k) => {
  const b = document.createElement('button');
  b.className = 'tool-item';
  b.setAttribute('role', 'menuitemradio');
  b.dataset.tool = t.id;
  b.style.setProperty('--k', k);
  b.innerHTML = `<span class="tile-glyph">${Tools.glyph(t.id, 24)}</span><span><b>${t.name}</b><small>${t.blurb}</small></span>` +
    '<span class="tick" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" fill="none" stroke="#FBF8F3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  b.addEventListener('click', () => { closeSwitcher(true); showPage(t.id, true); });
  switchMenu.appendChild(b);
});
const items = () => [...switchMenu.querySelectorAll('.tool-item')];

function openSwitcher() {
  switchMenu.classList.add('open');
  switchBtn.setAttribute('aria-expanded', 'true');
  (items().find((b) => b.dataset.tool === currentPage) || items()[0]).focus({ preventScroll: true });
}
function closeSwitcher(refocus = false) {
  if (!switchMenu.classList.contains('open')) return;
  switchMenu.classList.remove('open');
  switchBtn.setAttribute('aria-expanded', 'false');
  if (refocus) switchBtn.focus({ preventScroll: true });
}
switchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (switchMenu.classList.contains('open')) closeSwitcher();
  else openSwitcher();
});
addEventListener('pointerdown', (e) => { if (!e.target.closest('#switcher')) closeSwitcher(); });
addEventListener('blur', () => closeSwitcher());
switchMenu.addEventListener('keydown', (e) => {
  const list = items(), i = list.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(true); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
  }
});

// The button's label rolls over to the new tool's name.
function labelButton(id, animate) {
  const t = Tools.TOOLS.find((x) => x.id === id);
  const name = document.getElementById('swName');
  document.getElementById('swGlyph').innerHTML = Tools.glyph(id, 16);
  switchBtn.setAttribute('aria-label', `Tool: ${t.name}. Switch tools`);
  if (!animate) { name.textContent = t.name; return; }
  name.classList.add('out');
  setTimeout(() => { name.textContent = t.name; name.classList.remove('out'); }, 140);
}

function showPage(id, animate) {
  if (!PAGES[id] || id === currentPage) return;
  const from = PAGES[currentPage];
  const to = PAGES[id];
  currentPage = id;
  // Each tool wears its own theme: the whole window recolors as you switch.
  const tool = Tools.TOOLS.find((t) => t.id === id);
  document.documentElement.dataset.theme = tool.theme;
  scrawl.send('window:bg', tool.bg);
  items().forEach((b) => b.setAttribute('aria-checked', b.dataset.tool === id));
  labelButton(id, animate);
  if (typeof cancelAwayListening === 'function') cancelAwayListening();
  if (typeof cancelJotListening === 'function') cancelJotListening();
  if (listening) { stopListening(); scrawl.send('bind:cancel'); } // a held key being chosen on the page you're leaving
  if (S && S.page !== id) save({ page: id });
  if (!animate || !from) {
    for (const p of Object.values(PAGES)) p.hidden = p !== to;
    fit();
    return;
  }
  // Old page sinks away and the new one rises in.
  from.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(0.985)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' })
    .finished.then(() => {
      from.getAnimations().forEach((a) => a.cancel());
      from.hidden = true;
      to.hidden = false;
      fit();
      to.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: SMOOTH_EASE });
      to.querySelectorAll('.card, .keycap, .brand .mark').forEach((el, i) =>
        el.animate([{ transform: 'translateY(10px) scale(0.92)' }, { transform: 'none' }], { duration: 560, delay: 40 + i * 30, easing: BOUNCY, fill: 'backwards' }));
    });
}
const SMOOTH_EASE = getComputedStyle(document.documentElement).getPropertyValue('--smooth').trim();

// ---------- one window size for every page ----------
// The window is as tall as the tallest page (and never shorter than the "Show me how" sheet needs),
// so switching tools never resizes it. It grows right away when a page's content grows, and shrinks
// back (a moment later, once things settle) when content goes away, like the Accessibility banner
// folding up after access is granted.
const DEMO_ROOM = 580;
let windowH = 0;
let fitFrame = 0;
let shrinkTimer = 0;
function naturalHeight(p) {
  // Measure every page as if it were showing, without painting the hidden ones.
  const hidden = p.hidden;
  p.hidden = false;
  p.style.cssText += ';position:absolute;visibility:hidden;min-height:0';
  const h = p.offsetHeight;
  p.style.position = p.style.visibility = p.style.minHeight = '';
  p.hidden = hidden;
  return h;
}
function tallest() { return Math.max(DEMO_ROOM, ...Object.values(PAGES).map(naturalHeight)); }
function fit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    const h = tallest();
    if (h > windowH) {
      clearTimeout(shrinkTimer);
      windowH = h;
      scrawl.send('window:fit', h, false);
    } else if (h < windowH) {
      // Wait out a collapse animation, then shrink once, smoothly.
      clearTimeout(shrinkTimer);
      shrinkTimer = setTimeout(() => {
        const now = tallest();
        if (now >= windowH) return;
        windowH = now;
        scrawl.send('window:fit', now, true);
      }, 450);
    }
  });
}
const ro = new ResizeObserver(() => fit());
Object.values(PAGES).forEach((p) => ro.observe(p));

// Fill each brand mark with its tool's glyph.
document.querySelectorAll('.mark[data-glyph]').forEach((m) => { m.innerHTML = Tools.glyph(m.dataset.glyph, 22); });

// Called by settings.js once settings have loaded.
function startSwitcher() {
  showPage(S.page in PAGES ? S.page : 'scrawl', false);
}
