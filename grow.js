// The editor opening (grow.html): springs a stand-in window from the file's rectangle to the editor's.
const q = new URLSearchParams(location.search);
const [fx, fy, fw, fh] = q.get('from').split(',').map(Number);
const [tx, ty, tw, th] = q.get('to').split(',').map(Number);
const g = document.getElementById('g');
Object.assign(g.style, { width: `${tw}px`, height: `${th}px` });
// A spring sampled into keyframes (a little overshoot, settles quickly). Scale stays separate per axis,
// so the stand-in starts with the file's own shape.
const frames = [], N = 40, k = 210, damp = 22;
let x = 0, v = 0;
for (let i = 0; i <= N; i++) {
  const p = Math.min(1, x);
  const sx = (fw + (tw - fw) * x) / tw, sy = (fh + (th - fh) * x) / th;
  frames.push({
    transform: `translate(${fx + (tx - fx) * x}px, ${fy + (ty - fy) * x}px) scale(${sx}, ${sy})`,
    opacity: Math.min(1, 0.2 + p * 2.2),
    borderRadius: `${12 / Math.max(0.05, Math.min(sx, sy))}px`,
  });
  for (let s = 0; s < 4; s++) { v += (k * (1 - x) - damp * v) * (1 / 240); x += v * (1 / 240); }
}
g.animate(frames, { duration: 380, easing: 'linear', fill: 'forwards' });
