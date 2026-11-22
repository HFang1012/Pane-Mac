// Tweak's pointer layer (target.html): marks the file under the pointer and tags it with its name and type.
const ICONS = {
  image: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="9" cy="9.5" r="1.8"/><path d="M20 15.5l-4.5-4.5L6 20"/>',
  video: '<rect x="3" y="5.5" width="13" height="13" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  text: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  rich: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  dir: '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.5l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z"/>',
  other: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 15.5l7-7"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ICONS.other}</svg>`;
const mark = document.getElementById('mark'), tag = document.getElementById('tag');
document.getElementById('hintGlyph').innerHTML = Tools.glyph('tweak', 18);
const size = (n) => (n == null ? '' : n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

// Only the screen with the pointer shows the hint.
if (new URLSearchParams(location.search).get('primary') === '1') document.body.classList.add('primary');

// Four crop corners, one at each corner of the file: an L whose arms run along its edges. The arms stay
// short (about a sixth of the side) so the corners never join up into a box.
const GAP = 0;
function corners(x, y, w, h) {
  const L = Math.max(7, Math.min(13, Math.min(w, h) * 0.16));
  const f = (n) => +n.toFixed(2);
  const out = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = (sx < 0 ? x : x + w) + sx * GAP, cy = (sy < 0 ? y : y + h) + sy * GAP;
    out.push(`M${f(cx - sx * L)} ${f(cy)}L${f(cx)} ${f(cy)}L${f(cx)} ${f(cy - sy * L)}`);
  }
  return out.join('');
}

// The marks and the tag follow a spring (critically damped: quick, no wobble), redrawn every frame,
// so the outline slides and reshapes between files instead of jumping.
const paths = [...mark.querySelectorAll('path')];
const cur = { x: 0, y: 0, w: 0, h: 0 }, vel = { x: 0, y: 0, w: 0, h: 0 };
let goal = null, tagGoal = null, frame = 0, lastT = 0;
const tagCur = { x: 0, y: 0 }, tagVel = { x: 0, y: 0 };
function draw() {
  const d = corners(cur.x, cur.y, Math.max(1, cur.w), Math.max(1, cur.h));
  for (const p of paths) p.setAttribute('d', d);
  tag.style.left = `${tagCur.x}px`; tag.style.top = `${tagCur.y}px`;
}
function step(t) {
  const dt = Math.min(0.05, (t - (lastT || t)) / 1000 || 0.016);
  lastT = t;
  const k = 380, damp = 2 * Math.sqrt(k); // stiffness, and just enough damping not to overshoot
  let moving = false;
  const spring = (c, v, g, key) => {
    const a = k * (g[key] - c[key]) - damp * v[key];
    v[key] += a * dt; c[key] += v[key] * dt;
    if (Math.abs(g[key] - c[key]) > 0.05 || Math.abs(v[key]) > 0.05) moving = true; else { c[key] = g[key]; v[key] = 0; }
  };
  if (goal) for (const key of ['x', 'y', 'w', 'h']) spring(cur, vel, goal, key);
  if (tagGoal) for (const key of ['x', 'y']) spring(tagCur, tagVel, tagGoal, key);
  draw();
  frame = moving ? requestAnimationFrame(step) : 0;
  if (!moving) lastT = 0;
}
const run = () => { if (!frame) frame = requestAnimationFrame(step); };

let last = null;
scrawl.on('target:hit', (h) => {
  if (!h) { mark.classList.remove('on'); tag.classList.remove('on'); last = null; return; }
  const appearing = !mark.classList.contains('on');
  tag.classList.toggle('nope', !h.ok); // the tag says why; the marks stay one color
  document.getElementById('tagIcon').innerHTML = svg(h.kind);
  document.getElementById('tagName').textContent = h.name;
  document.getElementById('tagSub').textContent = h.ok ? [h.label, size(h.size)].filter(Boolean).join(', ') : h.why;
  // The tag sits under the file (under a desktop icon's name), or above it near the bottom, kept on screen.
  const tw = Math.min(340, tag.offsetWidth || 220), th = 46;
  let tx = h.desktop ? h.x + h.w / 2 - tw / 2 : h.x + 10;
  let ty = h.y + h.h + (h.desktop ? 40 : 12);
  if (ty + th > innerHeight - 8) ty = h.y - th - 12;
  tx = Math.max(8, Math.min(tx, innerWidth - tw - 8));
  goal = { x: h.x, y: h.y, w: h.w, h: h.h };
  tagGoal = { x: tx, y: ty };
  if (appearing) {
    // Close in on the file from a little outside it, rather than flying in from the last one.
    Object.assign(cur, { x: h.x - h.w * 0.12, y: h.y - h.h * 0.12, w: h.w * 1.24, h: h.h * 1.24 });
    Object.assign(vel, { x: 0, y: 0, w: 0, h: 0 });
    Object.assign(tagCur, { x: tx, y: ty + 6 }); Object.assign(tagVel, { x: 0, y: 0 });
    draw();
  }
  run();
  mark.classList.add('on'); tag.classList.add('on');
  last = h;
});
scrawl.on('target:nope', () => { mark.classList.remove('shake'); void mark.offsetWidth; mark.classList.add('shake'); });
// Opening a file: the corners press into it. Putting the pointer away: they drift out from it.
scrawl.on('target:leave', (o) => {
  if (goal && mark.classList.contains('on')) {
    const p = o?.open ? -Math.min(goal.w, goal.h) * 0.16 : 12;
    goal = { x: goal.x - p, y: goal.y - p, w: goal.w + p * 2, h: goal.h + p * 2 };
    run();
  }
  document.body.classList.add('leave');
});
