// The wheel: one module shared by the overlay, the settings preview and the main process
// (for hit-testing), so what you see and what you pick always come from the same geometry.
(function () {
  const ICONS = {
    pencil: '<path d="M4 20l1.2-4.4L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z"/><path d="M13.5 7.3l3.2 3.2"/>',
    eraser: '<path d="M7 20.5h13"/><path d="M3.8 15.2l9.4-9.4a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L11.6 19.4H8z"/><path d="M8.6 10.4l5 5"/>',
    show: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
    clear: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.2 7l.9 12.5h9.8L17.8 7"/><path d="M10 11v5"/><path d="M14 11v5"/>',
    // Slightly curved arrows: back (undo) and forward (redo).
    undo: '<path d="M20 17Q18 8 7 9"/><path d="M11 5L7 9l4 4"/>',
    redo: '<path d="M4 17Q6 8 17 9"/><path d="M13 5l4 4-4 4"/>',
    // The color picker: an eyedropper.
    picker: '<path d="M14.6 3.6a2.4 2.4 0 0 1 3.4 0l2.4 2.4a2.4 2.4 0 0 1 0 3.4l-2.6 2.6-5.8-5.8z"/><path d="M10.6 5.4l8 8"/><path d="M13 9L5.4 16.6a2 2 0 0 0-.6 1.4v1.2h1.2a2 2 0 0 0 1.4-.6L15 11"/>',
  };
  // Path-only versions for drawing on a canvas (Path2D understands SVG path data).
  const CURSOR_PATHS = {
    pencil: ['M4 20l1.2-4.4L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z', 'M13.5 7.3l3.2 3.2'],
    eraser: ['M7 20.5h13', 'M3.8 15.2l9.4-9.4a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L11.6 19.4H8z', 'M8.6 10.4l5 5'],
    picker: ['M14.6 3.6a2.4 2.4 0 0 1 3.4 0l2.4 2.4a2.4 2.4 0 0 1 0 3.4l-2.6 2.6-5.8-5.8z', 'M10.6 5.4l8 8', 'M13 9L5.4 16.6a2 2 0 0 0-.6 1.4v1.2h1.2a2 2 0 0 0 1.4-.6L15 11'],
  };

  // Ring tools. `weight` is the share of the circle: the pencil is a bit bigger, undo/redo are half-size.
  const TOOLS = {
    pencil: { name: 'Pencil', weight: 1.4 },
    eraser: { name: 'Eraser' },
    toggle: { name: 'Show / hide' },
    clear: { name: 'Clear all' },
    undo: { name: 'Undo', half: true },
    redo: { name: 'Redo', half: true },
  };
  const weight = (id) => TOOLS[id]?.weight ?? (TOOLS[id]?.half ? 0.5 : 1);

  // Pencil colors, offered in settings and on the wheel (fanned out beside the pencil).
  const COLORS = [
    { hex: '#E5484D', lip: '#B8343A', name: 'Red' },
    { hex: '#F5A524', lip: '#C9811A', name: 'Orange' },
    { hex: '#2FA36B', lip: '#217A50', name: 'Green' },
    { hex: '#3A7BEA', lip: '#2A5DB8', name: 'Blue' },
    { hex: '#8E5BE8', lip: '#6B41B8', name: 'Violet' },
    { hex: '#262B36', lip: '#0F1218', name: 'Graphite' },
    { hex: '#FFFFFF', lip: '#C6CFDB', name: 'White' },
  ];
  const COLOR_HOVER = 1000; // hover codes from 1000 up mean "pencil in COLORS[code - 1000]"
  // One past the last color: the color picker, which takes the pencil's color from the screen.
  const PICK_HOVER = COLOR_HOVER + COLORS.length;
  // -1 for a color that isn't one of COLORS (one taken with the picker).
  const colorIndex = (hex) => COLORS.findIndex((c) => c.hex.toLowerCase() === String(hex).toLowerCase());

  // Chunky, Lull-style glyphs for the settings tiles: flat shapes with a darker lip underneath.
  const G = { ink: '#262B36', inkLip: '#0F1218', pink: '#F49CB0', pinkLip: '#D96F8A', sky: '#A9C1EC', skyLip: '#7F9BD1', paper: '#F3EEE6', paperLip: '#D8CFC2' };
  function chunky(shape, fill, lip, dy = 3) {
    return `<g transform="translate(0 ${dy})" fill="${lip}">${shape}</g><g fill="${fill}">${shape}</g>`;
  }
  function chunkyArrow(arc, head, fill, lip) {
    const shape = `<path d="${arc}" fill="none" stroke-width="6" stroke-linecap="round"/><path d="${head}" stroke-width="2.5" stroke-linejoin="round"/>`;
    return `<g transform="translate(0 3)" fill="${lip}" stroke="${lip}">${shape}</g><g fill="${fill}" stroke="${fill}">${shape}</g>`;
  }
  const GLYPHS = {
    pencil: () => {
      const body = '<rect x="12" y="17" width="26" height="11" rx="2"/>';
      const cap = '<rect x="5" y="17" width="9" height="11" rx="4"/>';
      const tip = '<path d="M38 17 L50 22.5 L38 28 Z"/>';
      const lead = '<path d="M46 20.7 L50 22.5 L46 24.3 Z"/>';
      return `<g transform="rotate(-28 28 22)">${chunky(body, G.sky, G.skyLip)}${chunky(cap, G.pink, G.pinkLip)}${chunky(tip, G.paper, G.paperLip)}<g fill="${G.ink}">${lead}</g></g>`;
    },
    eraser: () => {
      const pinkPart = '<rect x="8" y="14" width="24" height="17" rx="5"/>';
      const sleeve = '<rect x="26" y="14" width="22" height="17" rx="4"/>';
      return `<g transform="rotate(-18 28 22)">${chunky(pinkPart, G.pink, G.pinkLip)}${chunky(sleeve, G.sky, G.skyLip)}</g>`;
    },
    toggle: () => {
      const eye = '<path d="M6 22 C14 9, 42 9, 50 22 C42 35, 14 35, 6 22 Z"/>';
      const iris = '<circle cx="28" cy="22" r="7"/>';
      const slash = '<rect x="26" y="2" width="5" height="40" rx="2.5" transform="rotate(-42 28 22)"/>';
      return chunky(eye, G.sky, G.skyLip) + chunky(iris, G.ink, G.inkLip, 2) + chunky(slash, G.pink, G.pinkLip, 2);
    },
    clear: () => {
      const can = '<path d="M15 14 H41 L38 39 H18 Z"/>';
      const lid = '<rect x="11" y="8" width="34" height="6" rx="3"/>';
      const handle = '<rect x="23" y="4" width="10" height="5" rx="2"/>';
      const spark = '<path d="M47 27 l2 -5 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 z"/>';
      return chunky(handle, G.ink, G.inkLip, 2) + chunky(can, G.sky, G.skyLip) + chunky(lid, G.ink, G.inkLip, 2) + chunky(spark, G.pink, G.pinkLip, 2);
    },
    // Half-size glyphs (viewBox 28×44): a gently curved arrow each way.
    undo: () => chunkyArrow('M23 30 Q22 17 11 17', 'M12 10 L4 17 L12 24 Z', G.sky, G.skyLip),
    redo: () => chunkyArrow('M5 30 Q6 17 17 17', 'M16 10 L24 17 L16 24 Z', G.pink, G.pinkLip),
  };
  function glyph(id, h = 44) {
    const half = TOOLS[id]?.half;
    const vw = half ? 28 : 56;
    return `<svg width="${(h * vw) / 44}" height="${h}" viewBox="0 0 ${vw} 44" aria-hidden="true">${GLYPHS[id]()}</svg>`;
  }

  function look(id, visible) {
    if (id === 'toggle') return { icon: visible ? 'hide' : 'show', label: visible ? 'Hide all' : 'Show all' };
    return { icon: id, label: TOOLS[id].name };
  }

  function icon(name, size = 24) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  }
  function iconGroup(name, x, y, size, cls, extra = '') {
    // Outer group places the icon; inner group is free for CSS transforms (scale on hover).
    return `<g transform="translate(${(x - size / 2).toFixed(2)} ${(y - size / 2).toFixed(2)}) scale(${(size / 24).toFixed(4)})">` +
      `<g class="${cls}" ${extra} fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
      `<rect width="24" height="24" fill="none" stroke="none"/>${ICONS[name]}</g></g>`;
  }

  /** Geometry shared by rendering and hit-testing. */
  function metrics(size) {
    const R = size, r = size * 0.4, depth = Math.max(3, Math.round(size * 0.055));
    const pad = 4, box = Math.ceil(R * 2 + depth + pad * 2);
    const hubR = r - Math.max(4, size * 0.07);
    return { R, r, hubR, depth, press: depth * 0.7, box, cx: box / 2, cy: pad + R };
  }

  /**
   * Angles (radians, 0 = right, clockwise) for each item, sized by weight.
   * The first item is centred at the top.
   */
  function layout(items) {
    const total = items.reduce((s, id) => s + weight(id), 0) || 1;
    const unit = (Math.PI * 2) / total;
    let a = -Math.PI / 2 - (weight(items[0]) * unit) / 2;
    return items.map((id) => {
      const span = weight(id) * unit;
      const seg = { id, start: a, end: a + span, mid: a + span / 2, span };
      a += span;
      return seg;
    });
  }

  /**
   * The pencil's colors: dots on an arc just outside the pencil slice, with the current color in the
   * middle, so flicking straight at the pencil keeps your color. The color picker comes last, past the
   * clockwise end. Offsets are from the wheel's centre.
   */
  function colorRing(size, items, pencilColor) {
    const seg = layout(items).find((s) => s.id === 'pencil');
    if (!seg) return null;
    const { R } = metrics(size);
    const dotR = Math.max(6, size * 0.1);
    const rc = R + dotR + Math.max(6, size * 0.08);
    const step = (dotR * 2 + Math.max(5, size * 0.06)) / rc; // angle between neighbouring dots
    const mid = Math.floor(COLORS.length / 2);
    const current = Math.max(0, colorIndex(pencilColor));
    const dot = (ci, k) => {
      const angle = seg.mid + (k - mid) * step;
      return { ci, k, angle, x: rc * Math.cos(angle), y: rc * Math.sin(angle) };
    };
    const dots = COLORS.map((_, k) => dot((current - mid + k + COLORS.length) % COLORS.length, k));
    dots.push({ ...dot(COLORS.length, COLORS.length), pick: true });
    return { dots, dotR, rc, step, mid: seg.mid, R };
  }

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // to (-π, π]

  /**
   * What's under an offset from the wheel's centre:
   * -1 the middle (let go there to cancel), n a slice index, COLOR_HOVER + i the pencil in COLORS[i].
   */
  function hitTest(size, items, dx, dy, pencilColor) {
    const d = Math.hypot(dx, dy);
    if (d < metrics(size).hubR + 2 || !items.length) return -1;
    const ring = colorRing(size, items, pencilColor);
    if (ring && d > ring.R + 2 && d < ring.rc + ring.dotR + 16) {
      const k = Math.round(wrap(Math.atan2(dy, dx) - ring.mid) / ring.step) + Math.floor(COLORS.length / 2);
      if (k >= 0 && k < ring.dots.length) return COLOR_HOVER + ring.dots[k].ci; // the last dot is the picker
    }
    const segs = layout(items);
    const base = segs[0].start;
    const t = (((Math.atan2(dy, dx) - base) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const i = segs.findIndex((s) => t < s.end - base);
    return i < 0 ? segs.length - 1 : i;
  }

  /** Builds the wheel SVG markup. Hover state is applied later with setHover(). */
  function build({ items, size = 84, visible = true, active = null, enter = true, pencilColor = null, colors = true }) {
    const { R, r, hubR, depth, press, box, cx, cy } = metrics(size);
    const gap = Math.max(2.2, size * 0.03);
    const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
    let slices = '';

    layout(items).forEach(({ id, start, end, mid }, i) => {
      let d;
      if (items.length === 1) {
        d = `M${cx - R},${cy}a${R},${R} 0 1 0 ${R * 2},0a${R},${R} 0 1 0 ${-R * 2},0Z M${cx - r},${cy}a${r},${r} 0 1 1 ${r * 2},0a${r},${r} 0 1 1 ${-r * 2},0Z`;
      } else {
        // Outer and inner arcs each get their own angular inset, so the groove is an even width.
        const a0 = start + gap / R, a1 = end - gap / R;
        const b0 = start + gap / r, b1 = end - gap / r;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        d = `M${pt(R, a0)}A${R},${R} 0 ${large} 1 ${pt(R, a1)}L${pt(r, b1)}A${r},${r} 0 ${large} 0 ${pt(r, b0)}Z`;
      }
      const half = TOOLS[id]?.half;
      const scale = half ? 0.2 : id === 'pencil' ? 0.28 : 0.24;
      const ir = (R + r) / 2, iconSize = Math.max(half ? 11 : 13, size * scale);
      const ix = cx + ir * Math.cos(mid), iy = cy + ir * Math.sin(mid);
      const dot = active === id
        ? `<circle class="act" cx="${(cx + (R - depth - 2) * Math.cos(mid)).toFixed(2)}" cy="${(cy + (R - depth - 2) * Math.sin(mid)).toFixed(2)}" r="${Math.max(2, size * 0.028).toFixed(2)}"/>`
        : '';
      slices +=
        `<g class="slice" data-i="${i}" data-id="${id}" style="--i:${i}">` +
        `<path class="edge" d="${d}" transform="translate(0 ${depth})" fill-rule="evenodd"/>` +
        `<g class="face"><path class="top" d="${d}" fill-rule="evenodd"/>${iconGroup(look(id, visible).icon, ix, iy, iconSize, 'ico')}${dot}</g>` +
        `</g>`;
    });

    // The pencil's colors, hidden until you point at the pencil.
    let ring = '';
    const cr = colors && pencilColor ? colorRing(size, items, pencilColor) : null;
    if (cr) {
      const current = colorIndex(pencilColor);
      ring = `<g class="colors">` + cr.dots.map(({ ci, k, x, y, pick }) => {
        const c = COLORS[ci], X = (cx + x).toFixed(2), Y = (cy + y).toFixed(2);
        // A color from the picker is ringed on the picker itself.
        const sel = ci === current || (pick && current < 0) ? `<circle class="sel" cx="${X}" cy="${Y}" r="${(cr.dotR + 3.5).toFixed(2)}"/>` : '';
        if (pick) {
          return `<g class="dot pick" data-c="${ci}" style="--k:${Math.abs(k - COLORS.length / 2 + 0.5)}">` +
            `<circle class="pick-edge" cx="${X}" cy="${(cy + y + 2).toFixed(2)}" r="${cr.dotR.toFixed(2)}"/>` +
            `<circle class="pick-top" cx="${X}" cy="${Y}" r="${cr.dotR.toFixed(2)}"/>` +
            `${iconGroup('picker', cx + x, cy + y, cr.dotR * 1.3, 'pick-ico')}${sel}</g>`;
        }
        const edge = c.hex === '#FFFFFF' ? ' stroke="#C6CFDB" stroke-width="1"' : '';
        return `<g class="dot" data-c="${ci}" style="--k:${Math.abs(k - cr.dots.length / 2 + 0.5)}">` +
          `<circle cx="${X}" cy="${(cy + y + 2).toFixed(2)}" r="${cr.dotR.toFixed(2)}" fill="${c.lip}"/>` +
          `<circle cx="${X}" cy="${Y}" r="${cr.dotR.toFixed(2)}" fill="${c.hex}"${edge}/>${sel}</g>`;
      }).join('') + `</g>`;
    }

    // The middle shows the icon of whatever you're pointing at (letting go there cancels).
    // Every icon is pre-placed so swaps can animate.
    const hubIcon = Math.max(14, hubR * 1.05);
    const names = [...new Set([...items.map((id) => look(id, visible).icon), ...(cr ? ['picker'] : [])])];
    const hubIcons = names.map((name) => iconGroup(name, cx, cy, hubIcon, 'hub-ico', `data-icon="${name}"`)).join('');
    const hub =
      `<g class="hub"><circle class="hub-edge" cx="${cx}" cy="${cy + depth * 0.7}" r="${hubR}"/>` +
      `<g class="hub-face"><circle class="hub-top" cx="${cx}" cy="${cy}" r="${hubR}"/>${hubIcons}</g></g>`;

    return `<svg class="wheel${enter ? ' enter' : ''}" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" ` +
      `style="--cx:${cx}px;--cy:${cy}px;--press:${press}px" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tool wheel">` +
      `<g class="wheel-body">${slices}</g>${ring}${hub}</svg>`;
  }

  /**
   * hover: null = nothing, -1 = the middle (cancel), n = slice n, COLOR_HOVER + i = pencil in COLORS[i].
   * Pointing at a slice swaps the middle icon to that tool; pointing at a color tints the pencil icon.
   */
  function setHover(svg, hover, items, visible, active) {
    if (!svg) return;
    const isColor = hover != null && hover >= COLOR_HOVER;
    const slice = isColor ? items.indexOf('pencil') : hover;
    svg.querySelectorAll('.slice').forEach((g) => g.classList.toggle('hot', slice != null && Number(g.dataset.i) === slice));
    svg.querySelector('.colors')?.classList.toggle('show', slice != null && slice >= 0 && items[slice] === 'pencil');
    svg.querySelectorAll('.colors .dot').forEach((g) => g.classList.toggle('hot', isColor && Number(g.dataset.c) === hover - COLOR_HOVER));

    // Middle icon: the tool you point at; over the middle itself, the tool in your hand, faded.
    const id = slice != null && slice >= 0 ? items[slice] : (hover === -1 && items.includes(active) ? active : null);
    const isPick = hover === PICK_HOVER;
    const name = isPick ? 'picker' : id ? look(id, visible).icon : null;
    const tint = isColor && !isPick ? (COLORS[hover - COLOR_HOVER].hex === '#FFFFFF' ? '#9AA3B2' : COLORS[hover - COLOR_HOVER].hex) : '';
    svg.querySelectorAll('.hub-ico').forEach((g) => {
      const on = g.dataset.icon === name;
      g.classList.toggle('on', on);
      g.classList.toggle('dim', on && !(slice >= 0));
      g.style.color = on && g.dataset.icon === 'pencil' ? tint : '';
    });
  }

  const api = { ICONS, CURSOR_PATHS, TOOLS, COLORS, COLOR_HOVER, PICK_HOVER, weight, look, icon, glyph, build, setHover, metrics, layout, colorRing, hitTest };
  if (typeof window !== 'undefined') window.Wheel = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
