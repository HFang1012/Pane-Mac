// The Plugin page of the settings window. Shares S, save(), swapText(), status and shortcutWell() with
// settings.js. The list of plugins comes from the main process (plugin:list), live while the page shows.
function savePlugin(patch) {
  return save({ plugin: { ...S.plugin, ...patch } });
}
const pluginShortcut = shortcutWell({ tool: 'plugin', well: document.getElementById('pluginWell'), caption: 'pluginCaption', label: 'Plugin keys' });
document.getElementById('pluginPower').addEventListener('click', (e) => {
  e.currentTarget.blur();
  pluginShortcut.cancel();
  savePlugin({ enabled: !S.plugin.enabled }).then(pollStatus);
});
document.getElementById('tryPlugin').addEventListener('click', (e) => { e.currentTarget.blur(); scrawl.send('plugin:try'); });
document.querySelectorAll('#pluginPage .picks').forEach((group) => {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    b.blur();
    if (S.plugin[group.dataset.key] !== b.dataset.v) savePlugin({ [group.dataset.key]: b.dataset.v });
  });
});
document.querySelectorAll('#pluginPage [data-perm]').forEach((b) => b.addEventListener('click', () => { b.blur(); scrawl.send('plugin:perm', b.dataset.perm); }));

function updatePluginStatus() {
  if (!S?.plugin) return;
  const on = S.plugin.enabled !== false;
  const power = document.getElementById('pluginPower');
  power.classList.toggle('off', !on);
  power.setAttribute('aria-pressed', on);
  swapText(document.getElementById('pluginPowerText'), on ? 'Turn off' : 'Turn on');
  document.getElementById('pluginPage').classList.toggle('off', !on);
  const ready = on && status.pluginKey !== false && status.listening;
  document.getElementById('pluginStatus').classList.toggle('ready', ready);
  swapText(document.getElementById('pluginStatusText'), !on
    ? 'Off. Every plugin lets go of its app, and waits.'
    : status.pluginKey === false && status.listening ? `${S.plugin.keys.symbols.join('')} is taken by another app. Pick other keys.`
      : status.listening ? `On. Press ${S.plugin.keys.symbols.join('')} and click an app.`
        : status.trusted ? 'Starting up…' : 'Waiting for Accessibility access.');
}
let pluginStarted = false;
function updatePlugin() {
  if (!S?.plugin) return;
  if (!pluginStarted) {
    pluginStarted = true;
    pluginShortcut.render(S.plugin.keys.symbols, { pop: true });
    refreshPlugins();
  }
  document.getElementById('pluginLede').textContent = `Press ${S.plugin.keys.symbols.join('')} and click any app. A plug lands on its corner. Click the plug to share out your processor, memory, network and sound, give it a network of its own, or let it take over in Focus mode.`;
  document.querySelectorAll('#pluginPage .picks').forEach((group) => {
    const v = String(S.plugin[group.dataset.key]);
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === v));
  });
  updatePluginStatus();
}

// ---------- the list ----------
const pluginIcons = new Map();
const pesc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let plugList = [];
async function iconOf(p) {
  if (!p.path) return null;
  if (!pluginIcons.has(p.path)) pluginIcons.set(p.path, scrawl.invoke('plugin:icon', p.path));
  return pluginIcons.get(p.path);
}
function rowHtml(p, k, icon) {
  const pips = ['cpu', 'ram', 'net', 'out', 'mic'].map((a) => {
    const L = p.levels[a];
    return `<u class="${L >= 11 ? 'b' : L >= 1 && L < 10 ? 'l' : ''}" style="height:${L >= 1 && L < 10 ? 3 + L : L >= 11 ? 14 : 5}px"></u>`;
  }).join('');
  return `<div class="prow ${p.on ? pesc(p.status.tone) : 'off'}" data-id="${pesc(p.id)}" style="--k:${k}">
    ${icon ? `<img src="${icon}" alt="">` : `<span class="av">${pesc(p.name.slice(0, 1))}</span>`}
    <div><b>${pesc(p.name)}</b><small><i></i>${pesc(p.on ? (p.running ? `Active${p.status.detail && p.status.detail !== 'Nothing set yet' ? `, ${p.status.detail.toLowerCase()}` : ''}` : 'Active, waits for it to open') : 'Inactive')}</small></div>
    <span class="pips" aria-hidden="true">${pips}</span>
    <button class="switch small" role="switch" aria-checked="${p.on}" data-on aria-label="${pesc(p.name)} plugin on"></button>
    <span><button class="pbtn" data-open>Open</button> <button class="pbtn x" data-x>Unplug</button></span>
  </div>`;
}
async function renderPlugins() {
  const box = document.getElementById('plist');
  const icons = await Promise.all(plugList.map(iconOf));
  const html = plugList.map((p, k) => rowHtml(p, k, icons[k])).join('');
  if (box.dataset.sig === html) return;
  const first = !box.dataset.sig;
  box.dataset.sig = html;
  // Rows already there are updated in place, so the list doesn't replay its entrance every second.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const old = new Map([...box.children].map((el) => [el.dataset.id, el]));
  const rows = [...tmp.children].map((el) => {
    const was = old.get(el.dataset.id);
    if (!was) { if (!first) el.style.setProperty('--k', 0); return el; }
    old.delete(el.dataset.id);
    if (was.classList.contains('going')) return was;
    was.className = el.className;
    was.children[1].innerHTML = el.children[1].innerHTML;
    was.children[2].innerHTML = el.children[2].innerHTML;
    was.querySelector('[data-on]').setAttribute('aria-checked', el.querySelector('[data-on]').getAttribute('aria-checked'));
    return was;
  });
  for (const el of old.values()) if (!el.classList.contains('going')) el.remove();
  rows.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
  const n = plugList.length;
  document.getElementById('plugCount').textContent = n ? `${n} app${n === 1 ? '' : 's'} plugged in, ${plugList.filter((p) => p.on).length} on.` : `None yet. Press ${S.plugin.keys.symbols.join('')} and click an app.`;
  if (typeof fit === 'function') fit();
}
async function refreshPlugins() {
  const r = await scrawl.invoke('plugin:list');
  plugList = r?.list || [];
  renderPlugins();
}
scrawl.on('plugin:list', (list) => {
  if (document.getElementById('pluginPage').hidden || document.hidden) { plugList = list; return; }
  plugList = list;
  renderPlugins();
});
document.getElementById('plist').addEventListener('click', async (e) => {
  const row = e.target.closest('.prow');
  if (!row) return;
  const id = row.dataset.id;
  const p = plugList.find((x) => x.id === id);
  if (!p) return;
  if (e.target.closest('[data-on]')) { scrawl.invoke('plugin:set', id, { on: !p.on }); return; }
  if (e.target.closest('[data-open]')) { scrawl.send('plugin:open', id); return; }
  const x = e.target.closest('[data-x]');
  if (x) {
    // Unplug asks first, on the button itself.
    if (!x.classList.contains('sure')) {
      x.classList.add('sure');
      x.textContent = 'Sure?';
      setTimeout(() => { if (x.isConnected) { x.classList.remove('sure'); x.textContent = 'Unplug'; } }, 3500);
      return;
    }
    const r = await scrawl.invoke('plugin:remove', id);
    if (r?.ok === false) { x.classList.remove('sure'); x.textContent = 'Unplug'; return; }
    row.classList.add('going');
    setTimeout(() => { row.remove(); refreshPlugins(); }, 420);
  }
});
new MutationObserver(() => { if (!document.getElementById('pluginPage').hidden) refreshPlugins(); })
  .observe(document.getElementById('pluginPage'), { attributes: true, attributeFilter: ['hidden'] });
