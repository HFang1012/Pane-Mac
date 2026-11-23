// The tools Pane holds, and Away's moods. Shared by the settings window, the Away screen and the main
// process, so names, glyphs and colors come from one place.
(function () {
  // Each tool keeps its own colors: Scrawl's eraser pink on graphite, Away's lilac and apricot on plum.
  const C = { ink: '#2B2733', inkLip: '#16131C', accent: '#B9A5F4', accentLip: '#8E76DC', peach: '#FFC593', peachLip: '#E39C60' };
  const SC = { ink: '#262B36', inkLip: '#0F1218', pink: '#F49CB0', pinkLip: '#D96F8A' };
  // Spin: a green-black record with a mustard label, and a mint tone arm.
  const SP = { ink: '#1E2B27', inkLip: '#0B1210', mustard: '#FFC94D', mustardLip: '#DDA21F', mint: '#7ED3A8', mintLip: '#4DB283' };
  // Jot: airmail. A sky-blue note with deep teal lines, and a coral paper airplane taking off from it.
  const JT = { ink: '#17303A', inkLip: '#0A1A20', sky: '#9FD4EE', skyLip: '#68AFD3', coral: '#FF9B7A', coralLip: '#E26F4E' };
  // Tweak: a workbench. A cobalt page with its corner folded, and chartreuse crop marks laid over it.
  const TW = { ink: '#1B1D3A', inkLip: '#0C0D1F', cobalt: '#8192FF', cobaltLip: '#5567E3', lime: '#CDEB5A', limeLip: '#9CBD27' };
  // Debug: an outline bug in tomato red with near-black legs, and leaf green for "all good".
  const DB = { ink: '#2A1F24', inkLip: '#140E11', red: '#F25C54', redLip: '#C93A36', leaf: '#8CCB7E', leafLip: '#5FA552' };

  // Chunky glyphs: a flat shape over a darker copy of itself, nudged down (the "lip").
  const lip = (shape, fill, under, dy) => `<g transform="translate(0 ${dy})" fill="${under}" stroke="${under}">${shape}</g><g fill="${fill}" stroke="${fill}">${shape}</g>`;

  const GLYPHS = {
    // Scrawl's loop, ending where the pen touches down.
    scrawl: {
      viewBox: '200 270 640 470',
      body: () => {
        const loop = '<path d="M262 640 C372 640 480 590 506 470 C526 372 456 306 392 334 C318 366 326 492 424 566 C508 628 628 628 690 548 C716 514 734 474 746 436" fill="none" stroke-width="78" stroke-linecap="round" stroke-linejoin="round" class="scribble" stroke-dasharray="1400"/>';
        return lip(loop, SC.pink, SC.pinkLip, 30) + `<circle cx="752" cy="444" r="74" fill="${SC.inkLip}"/><circle cx="752" cy="414" r="74" fill="${SC.ink}"/>`;
      },
    },
    // Away: one of a few icons (a coffee cup by default), colored by the chosen mood.
    away: { viewBox: '0 0 60 44', body: (o = {}) => awayIcon(o.icon, mood(o.mood).icon) },
    // Spin: a record on the turntable, its arm resting on the groove.
    spin: {
      viewBox: '0 0 60 44',
      body: () => {
        const disc = '<circle cx="26" cy="22" r="18" stroke="none"/>';
        const label = '<circle cx="26" cy="22" r="7" stroke="none"/>';
        const arm = '<path d="M50 5 L50 16 Q50 24 40 28" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="6" r="4.5" stroke="none"/>';
        return lip(disc, SP.ink, SP.inkLip, 3) +
          `<circle cx="26" cy="22" r="12.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="1.4"/>` +
          `<g class="label">${lip(label, SP.mustard, SP.mustardLip, 1.5)}<circle cx="26" cy="22" r="1.8" fill="${SP.ink}"/><circle cx="29" cy="19.5" r="1.4" fill="#FFFFFF" fill-opacity="0.5"/></g>` +
          lip(arm, SP.mint, SP.mintLip, 2.5);
      },
    },
    // Jot: a rounded note with two lines on it, and a paper airplane leaving it.
    jot: {
      viewBox: '0 0 60 44',
      body: () => {
        const note = '<rect x="5" y="9" width="32" height="30" rx="8" stroke="none"/>';
        const lines = `<g stroke="${JT.ink}" stroke-width="3.2" stroke-linecap="round" fill="none"><path d="M12 20h16"/><path d="M12 28h10"/></g>`;
        const plane = '<path d="M27 24 L56 7 L47 36 L40.5 28.5 Z" stroke="none"/>';
        const fold = `<path d="M40.5 28.5 L56 7 L37 31 Z" fill="${JT.coralLip}" stroke="none"/>`;
        return lip(note, JT.sky, JT.skyLip, 3) + lines +
          `<g class="plane">${lip(plane, JT.coral, JT.coralLip, 2.5)}${fold}</g>`;
      },
    },
    // Tweak: a page with a folded corner, and crop marks over it.
    tweak: {
      viewBox: '0 0 60 44',
      body: () => {
        const page = '<path d="M11 5 H27 L37 15 V36 Q37 40 33 40 H11 Q7 40 7 36 V9 Q7 5 11 5 Z" stroke="none"/>';
        const fold = `<path d="M27 5 V12 Q27 15 30 15 H37 Z" fill="${TW.cobaltLip}" stroke="none"/>`;
        const lines = `<g stroke="${TW.ink}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.85"><path d="M13 22h10"/><path d="M13 29h6"/></g>`;
        const crop = '<g class="crop" fill="none" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"><path d="M30 13 H51 V31"/><path d="M24 19 V37 H45"/></g>';
        return lip(page, TW.cobalt, TW.cobaltLip, 3) + fold + lines +
          `<g transform="translate(0 2.2)">${crop.replace('class="crop"', `class="crop" stroke="${TW.limeLip}"`)}</g>` +
          crop.replace('class="crop"', `class="crop" stroke="${TW.lime}"`);
      },
    },
    // Debug: an outline bug. A rounded body split in two, a head, feelers and legs, all drawn as lines.
    debug: {
      viewBox: '0 0 60 44',
      body: () => {
        const legs = '<g class="legs"><path d="M18.5 22 L11 18"/><path d="M17.5 29 H9.5"/><path d="M18.5 36 L11 40"/><path d="M41.5 22 L49 18"/><path d="M42.5 29 H50.5"/><path d="M41.5 36 L49 40"/></g>';
        const top = '<path d="M25 9.5 L21.5 4"/><path d="M35 9.5 L38.5 4"/><path d="M24 15 Q24 9 30 9 Q36 9 36 15"/>';
        const shell = '<rect x="18.5" y="15" width="23" height="25.5" rx="11.5"/><path d="M30 20 V40"/>';
        const line = (d, color, under, dy) => `<g fill="none" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">${lip(d, color, under, dy).replace(/fill="[^"]*"/g, 'fill="none"')}</g>`;
        return line(legs + top, DB.ink, DB.inkLip, 1.6) + line(shell, DB.red, DB.redLip, 2.2);
      },
    },
  };
  // `opts` is only read by Away's glyph: { icon, mood }.
  function glyph(id, h = 22, opts) {
    const g = GLYPHS[id];
    const [, , vw, vh] = g.viewBox.split(' ').map(Number);
    return `<svg class="glyph-${id}" width="${((h * vw) / vh).toFixed(1)}" height="${h}" viewBox="${g.viewBox}" aria-hidden="true" overflow="visible">${g.body(opts)}</svg>`;
  }

  const TOOLS = [
    { id: 'scrawl', name: 'Scrawl', blurb: 'Draw on your screen.', theme: 'scrawl', bg: '#E3E8EF' },
    { id: 'away', name: 'Away', blurb: 'Blur your screen while you’re away.', theme: 'away', bg: '#ECE6DD' },
    { id: 'spin', name: 'Spin', blurb: 'Run your music from a wheel.', theme: 'spin', bg: '#E4ECE3' },
    { id: 'jot', name: 'Jot', blurb: 'Quick notes that remind you later.', theme: 'jot', bg: '#DFEDF0' },
    { id: 'tweak', name: 'Tweak', blurb: 'Point at a file and edit it.', theme: 'tweak', bg: '#E4E5F3' },
    { id: 'debug', name: 'Debug', blurb: 'See what’s slowing your Mac down.', theme: 'debug', bg: '#F1E6E3' },
  ];

  // Away's moods: three soft colors that drift behind the blur, and the two the icon is painted in
  // (its main shape and its accent, each with a darker lip).
  const MOODS = [
    { id: 'dusk', name: 'Dusk', colors: ['#B9A5F4', '#FFB38A', '#F3A6CB'], icon: { main: C.peach, mainLip: C.peachLip, accent: C.accent, accentLip: C.accentLip } },
    { id: 'sea', name: 'Sea', colors: ['#7CC4E8', '#8EE0C6', '#A3A9F6'], icon: { main: '#8EE0C6', mainLip: '#52BC9B', accent: '#7CC4E8', accentLip: '#4C9DC8' } },
    { id: 'grove', name: 'Grove', colors: ['#A6D98C', '#F2DC86', '#7ACFB6'], icon: { main: '#F2DC86', mainLip: '#D2B44E', accent: '#A6D98C', accentLip: '#76B55A' } },
    { id: 'ember', name: 'Ember', colors: ['#FF9C78', '#FFD07A', '#F28CA6'], icon: { main: '#FF9C78', mainLip: '#DE6E4A', accent: '#FFD07A', accentLip: '#E0A63E' } },
    { id: 'mist', name: 'Mist', colors: ['#CFC6DE', '#E8DECF', '#B9C6D2'], icon: { main: '#CFC6DE', mainLip: '#A497BE', accent: '#B9C6D2', accentLip: '#879AAE' } },
  ];
  const mood = (id) => MOODS.find((m) => m.id === id) || MOODS[0];

  // Away's icons, all on the same 60×44 box so they swap in place.
  const AWAY_ICONS = [
    { id: 'cup', name: 'Coffee' },
    { id: 'lunch', name: 'Lunch' },
    { id: 'moon', name: 'Resting' },
    { id: 'chat', name: 'Meeting' },
  ];
  function awayIcon(id, p) {
    const steam = (stroke, x1, x2) => `<g class="steam" fill="none" stroke="${stroke}" stroke-width="3.4" stroke-linecap="round"><path d="M${x1} 12 q-3 -3 0 -6 t0 -6" class="s1"/><path d="M${x2} 12 q-3 -3 0 -6 t0 -6" class="s2"/></g>`;
    const steamPair = (x1, x2) => `<g transform="translate(0 3)">${steam(p.accentLip, x1, x2)}</g>${steam(p.accent, x1, x2)}`;
    if (id === 'lunch') {
      // A bowl on its foot, chopsticks resting in it, steam rising.
      const bowl = '<path d="M7 19 H45 Q45 35 30 36 H22 Q7 35 7 19 Z" stroke="none"/>';
      const foot = '<rect x="17" y="35" width="18" height="5" rx="2.5" stroke="none"/>';
      const sticks = '<g fill="none" stroke-width="3.2" stroke-linecap="round"><path d="M33 17 L54 3"/><path d="M37 18 L56 9"/></g>';
      return steamPair(16, 25) + lip(sticks, C.ink, C.inkLip, 1.5) + lip(foot, C.ink, C.inkLip, 2) + lip(bowl, p.main, p.mainLip, 3);
    }
    if (id === 'moon') {
      // A crescent moon with two stars twinkling beside it.
      const moon = '<path d="M26.06 9 A15 15 0 1 0 40.55 27.64 A12 12 0 0 1 26.06 9 Z" stroke="none"/>';
      const star = (x, y, r) => `<path d="M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r} Z" stroke="none"/>`;
      return `<g class="twinkle t1">${lip(star(47, 9, 6.5), p.accent, p.accentLip, 1.5)}</g>` +
        `<g class="twinkle t2">${lip(star(53, 24, 4.5), p.accent, p.accentLip, 1.2)}</g>` +
        lip(moon, p.main, p.mainLip, 3);
    }
    if (id === 'chat') {
      // Two speech bubbles: you're talking with someone.
      const back = '<rect x="30" y="4" width="25" height="19" rx="9.5" stroke="none"/><path d="M47 21 L52 28 L41 22 Z" stroke="none"/>';
      const front = '<rect x="4" y="11" width="36" height="24" rx="12" stroke="none"/><path d="M11 31 L8 41 L21 33 Z" stroke="none"/>';
      const dots = `<g class="dots" fill="${C.ink}"><circle cx="13.5" cy="23" r="2.6" class="d1"/><circle cx="22" cy="23" r="2.6" class="d2"/><circle cx="30.5" cy="23" r="2.6" class="d3"/></g>`;
      return lip(back, p.accent, p.accentLip, 2.5) + lip(front, p.main, p.mainLip, 3) + dots;
    }
    // A cup on its saucer, steam curling up. You've gone to get coffee.
    const cup = '<path d="M12 17 H40 V27 Q40 37 30 37 H22 Q12 37 12 27 Z" stroke="none"/><path d="M39 19.5 h3.5 a5.5 5.5 0 0 1 0 11 h-4 v-4 h4 a1.5 1.5 0 0 0 0 -3 h-3.5 z" stroke="none"/>';
    const saucer = '<rect x="7" y="36" width="38" height="5" rx="2.5" stroke="none"/>';
    return steamPair(21, 31) + lip(saucer, C.ink, C.inkLip, 2) + lip(cup, p.main, p.mainLip, 3);
  }

  // How long Away has been up: "12 min", "1 hr 5 min". Null under a minute.
  function awayFor(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return null;
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} hr${hrs > 1 ? 's' : ''}${mins % 60 ? ` ${mins % 60} min` : ''}`;
  }

  const DEFAULT_MESSAGE = 'I’m away from my computer right now.';

  const api = { TOOLS, MOODS, mood, AWAY_ICONS, awayFor, glyph, DEFAULT_MESSAGE, COLORS: C, SPIN_COLORS: SP, JOT_COLORS: JT, TWEAK_COLORS: TW, DEBUG_COLORS: DB };
  if (typeof window !== 'undefined') window.Tools = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
