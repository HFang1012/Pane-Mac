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
    // Away: a cup on its saucer, steam curling up. You've gone to get coffee.
    away: {
      viewBox: '0 0 60 44',
      body: () => {
        const cup = '<path d="M12 17 H40 V27 Q40 37 30 37 H22 Q12 37 12 27 Z" stroke="none"/><path d="M39 19.5 h3.5 a5.5 5.5 0 0 1 0 11 h-4 v-4 h4 a1.5 1.5 0 0 0 0 -3 h-3.5 z" stroke="none"/>';
        const saucer = '<rect x="7" y="36" width="38" height="5" rx="2.5" stroke="none"/>';
        const steam = '<g class="steam" fill="none" stroke-width="3.4" stroke-linecap="round"><path d="M21 12 q-3 -3 0 -6 t0 -6" class="s1"/><path d="M31 12 q-3 -3 0 -6 t0 -6" class="s2"/></g>';
        return `<g transform="translate(0 3)">${steam.replace('class="steam"', `class="steam" stroke="${C.accentLip}"`)}</g>` +
          steam.replace('class="steam"', `class="steam" stroke="${C.accent}"`) +
          lip(saucer, C.ink, C.inkLip, 2) + lip(cup, C.peach, C.peachLip, 3);
      },
    },
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
  };
  function glyph(id, h = 22) {
    const g = GLYPHS[id];
    const [, , vw, vh] = g.viewBox.split(' ').map(Number);
    return `<svg class="glyph-${id}" width="${((h * vw) / vh).toFixed(1)}" height="${h}" viewBox="${g.viewBox}" aria-hidden="true" overflow="visible">${g.body()}</svg>`;
  }

  const TOOLS = [
    { id: 'scrawl', name: 'Scrawl', blurb: 'Draw on your screen.', theme: 'scrawl', bg: '#E3E8EF' },
    { id: 'away', name: 'Away', blurb: 'Blur your screen while you’re away.', theme: 'away', bg: '#ECE6DD' },
    { id: 'spin', name: 'Spin', blurb: 'Run your music from a wheel.', theme: 'spin', bg: '#E4ECE3' },
    { id: 'jot', name: 'Jot', blurb: 'Quick notes that remind you later.', theme: 'jot', bg: '#DFEDF0' },
  ];

  // Away's gradient blobs. Each mood is three soft colors that drift behind the blur.
  const MOODS = [
    { id: 'dusk', name: 'Dusk', colors: ['#B9A5F4', '#FFB38A', '#F3A6CB'] },
    { id: 'sea', name: 'Sea', colors: ['#7CC4E8', '#8EE0C6', '#A3A9F6'] },
    { id: 'grove', name: 'Grove', colors: ['#A6D98C', '#F2DC86', '#7ACFB6'] },
    { id: 'ember', name: 'Ember', colors: ['#FF9C78', '#FFD07A', '#F28CA6'] },
    { id: 'mist', name: 'Mist', colors: ['#CFC6DE', '#E8DECF', '#B9C6D2'] },
  ];
  const mood = (id) => MOODS.find((m) => m.id === id) || MOODS[0];

  const DEFAULT_MESSAGE = 'I’m away from my computer right now.';

  const api = { TOOLS, MOODS, mood, glyph, DEFAULT_MESSAGE, COLORS: C, SPIN_COLORS: SP, JOT_COLORS: JT };
  if (typeof window !== 'undefined') window.Tools = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
