/* Blockstead — versioned content: blocks, themes, journey, challenges,
 * tutorial lessons, practice presets, daily ruleset generator.
 * Shared browser (window.BSContent) / Node. Content is data-only; all
 * randomness enters through the config seed.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.BSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSContent = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- blocks ----------
  // Shape + icon + label reinforce color (color is never the only cue).
  var BLOCKS = {
    wood:  { label: 'Timber', icon: '\u{1FAB5}', color: 0xb07a45, colorHC: 0xb7791f, shape: 'beam' },
    stone: { label: 'Stone',  icon: '\u{1FAA8}', color: 0x8d9299, colorHC: 0x9aa0a8, shape: 'brick' },
    glass: { label: 'Glass',  icon: '\u{1F9CA}', color: 0x9fd8e8, colorHC: 0x4cc9f0, shape: 'pane' },
    plant: { label: 'Plant',  icon: '\u{1F33F}', color: 0x6fbf5a, colorHC: 0x2f9e44, shape: 'sprout' },
    lamp:  { label: 'Lamp',   icon: '\u{1F3EE}', color: 0xffd27a, colorHC: 0xffd60a, shape: 'lantern' },
    rock:  { label: 'Rock',   icon: '\u26F0',    color: 0x6b6560, colorHC: 0x6b6560, shape: 'boulder' }
  };
  var PLACEABLE = ['wood', 'stone', 'glass', 'plant', 'lamp'];

  // ---------- themes (cosmetic only: light, sky, ground, weather mood) ----------
  var THEMES = [
    { id: 'meadow',   name: 'Sunlit Meadow', unlockStars: 0,
      palette: { sky: 0x87bfe8, horizon: 0xd8ecdc, ground: 0x77a95c, soil: 0x8a6a48,
                 sun: 0xfff2cc, sunInt: 1.25, fog: 0xbcd8e8, water: 0x5f9fc8, leaf: 0x4f8f3f } },
    { id: 'ember',    name: 'Ember Dusk',    unlockStars: 12,
      palette: { sky: 0xe8a06a, horizon: 0xf5d0a0, ground: 0x8a7a4a, soil: 0x7a5638,
                 sun: 0xffc27a, sunInt: 1.0, fog: 0xd8a880, water: 0x7a88a8, leaf: 0x6a7a35 } },
    { id: 'frost',    name: 'Frostfell',     unlockStars: 30,
      palette: { sky: 0xa8c8e0, horizon: 0xe8f0f5, ground: 0xc8d4da, soil: 0x8a96a0,
                 sun: 0xeaf4ff, sunInt: 0.9, fog: 0xc8dce8, water: 0x7ab8d8, leaf: 0x5a7a6a } },
    { id: 'canyon',   name: 'Red Canyon',    unlockStars: 55,
      palette: { sky: 0xe8b088, horizon: 0xf0d0a8, ground: 0xb87a4f, soil: 0x96543a,
                 sun: 0xffd8a0, sunInt: 1.15, fog: 0xd8a888, water: 0x5f8fa8, leaf: 0x8a8a3a } },
    { id: 'nightfall',name: 'Nightfall',     unlockStars: 85,
      palette: { sky: 0x232c48, horizon: 0x3a4468, ground: 0x3a4a42, soil: 0x3a3230,
                 sun: 0x9fb8ff, sunInt: 0.45, fog: 0x2a3450, water: 0x2a3a58, leaf: 0x2f4a38 } }
  ];

  // ---------- plot sizes ----------
  var SIZES = {
    s: { cols: 4, rows: 4, maxH: 4 },
    m: { cols: 5, rows: 5, maxH: 5 },
    l: { cols: 6, rows: 6, maxH: 6 }
  };

  // ---------- gather presets (per-action yield ranges, deterministic) ----------
  var GATHERS = [
    { wood: [2, 3], stone: [1, 2] },                                          // 0 basic
    { wood: [1, 2], stone: [1, 1] },                                          // 1 lean
    { wood: [2, 3], stone: [1, 2], glass: [1, 1] },                           // 2 +glass
    { wood: [1, 2], stone: [1, 1], glass: [1, 2] },                           // 3 glassy lean
    { wood: [1, 2], stone: [1, 2], glass: [1, 1], lamp: [1, 1] },             // 4 +lamp
    { wood: [1, 2], stone: [1, 1], glass: [0, 1], plant: [1, 2] },            // 5 garden
    { wood: [1, 2], stone: [1, 2], glass: [1, 1], lamp: [0, 1], plant: [1, 1] }, // 6 full
    { wood: [2, 2], stone: [2, 2], glass: [1, 1], lamp: [1, 1], plant: [1, 1] }  // 7 rich
  ];

  // Goal codes: 'c:<type>:<n>' count, 'h:<n>' tallest column, 'k:<h>:<n>' n columns of height h.
  function parseGoal(code) {
    var p = code.split(':');
    if (p[0] === 'c') return { kind: 'count', type: p[1], n: +p[2] };
    if (p[0] === 'h') return { kind: 'height', n: +p[1] };
    if (p[0] === 'k') return { kind: 'columns', h: +p[1], n: +p[2] };
    throw new Error('bad goal code ' + code);
  }

  // ---------- journey ----------
  // Compact authored rows:
  // [id, name, seed, size, blockMask, startVec, gatherIdx, goals[],
  //  rocks, moveLimit, parMoves, themeIdx, intro]
  // blockMask: w=wood s=stone g=glass p=plant l=lamp; startVec aligns with mask.
  var J = [
    ['j01','First Foundation', 101,'s','ws',[3,2],0,['c:wood:3'],0,0,6,0,'Tap a block in the tray, then tap a plot tile to build. Gather when you run low.'],
    ['j02','Timber Frame',     102,'s','ws',[2,2],0,['c:wood:5'],0,0,9,0,''],
    ['j03','Stone Footing',    103,'s','ws',[2,2],0,['c:stone:4'],0,0,9,0,''],
    ['j04','Going Up',         104,'s','ws',[3,2],0,['h:2'],0,0,6,0,'Blocks stack. Build a column two blocks tall.'],
    ['j05','Little Tower',     105,'s','ws',[2,2],0,['h:3'],0,0,10,0,''],
    ['j06','Clear Panes',      106,'s','wsg',[2,2,0],2,['c:glass:3'],0,0,10,0,'New: Glass. It is fragile — it needs a block beneath it.'],
    ['j07','Sunroom',          107,'s','wsg',[2,2,0],2,['c:glass:4','c:wood:3'],0,0,14,0,''],
    ['j08','Twin Posts',       108,'s','ws',[3,2],0,['k:2:2'],0,0,11,0,'Raise two separate columns to height two.'],
    ['j09','Steady Rise',      109,'m','wsg',[2,2,1],2,['h:3','c:stone:4'],0,0,16,0,''],
    ['j10','Homestead',        110,'m','wsg',[2,2,1],2,['c:wood:4','c:stone:4','h:3'],0,0,18,0,'MASTERY: everything so far, one plot.'],
    ['j11','Lamplight',        111,'m','wsgl',[2,2,1,0],4,['c:lamp:2'],0,0,13,0,'New: the Lamp. It crowns a stack — nothing builds above it.'],
    ['j12','Lit Lanes',        112,'m','wsgl',[2,2,1,0],4,['c:lamp:3','k:2:3'],0,0,20,0,''],
    ['j13','Glass Tower',      113,'m','wsg',[2,2,1],2,['h:4','c:glass:3'],0,0,18,0,''],
    ['j14','First Garden',     114,'m','wsgpl',[2,2,1,0,0],6,['c:plant:3'],0,0,15,0,'New: the Plant. A living topper, like the lamp.'],
    ['j15','Green Roofs',      115,'m','wsgpl',[2,2,1,0,0],6,['c:plant:4','c:lamp:2'],0,0,20,0,''],
    ['j16','Move Budget',      116,'m','wsg',[2,2,1],2,['c:wood:5','c:stone:4'],0,22,18,0,'New: a move limit. Gathering spends moves too — plan ahead.'],
    ['j17','Quarry Town',      117,'l','wsg',[2,2,1],1,['c:stone:8'],0,0,18,0,'Lean gathers: every action yields less.'],
    ['j18','Sparse Supply',    118,'m','wsgl',[1,1,0,0],4,['c:lamp:2','h:3'],0,0,20,0,''],
    ['j19','Column Row',       119,'m','wsg',[3,2,1],2,['k:3:3'],0,0,22,0,''],
    ['j20','Village Square',   120,'l','wsgl',[2,2,1,0],4,['c:lamp:4','k:2:4','c:glass:4'],0,38,30,1,'MASTERY: lights, towers, and glass on the big plot.'],
    ['j21','Boulder Field',    121,'m','wsg',[2,2,1],2,['c:stone:5','h:3'],3,0,20,0,'New: Rocks. Immovable terrain — build around them, or on them.'],
    ['j22','Around the Rocks', 122,'m','wsg',[2,2,1],2,['k:2:3','c:wood:4'],4,0,20,0,''],
    ['j23','Rocky Garden',     123,'m','wsgpl',[2,2,1,0,0],6,['c:plant:4','c:lamp:2'],3,0,22,0,''],
    ['j24','Tight Turns',      124,'m','wsg',[2,2,1],2,['h:3','c:stone:5'],4,26,22,0,''],
    ['j25','Cliffside',        125,'l','wsg',[2,2,1],2,['h:5','c:stone:6'],5,40,32,1,'MASTERY: a rock-strewn plot and a tall order.'],
    ['j26','Tall Order',       126,'m','wsg',[2,2,1],2,['h:5'],0,0,16,0,''],
    ['j27','Glassworks',       127,'l','wsg',[2,2,2],3,['c:glass:8'],0,0,20,0,''],
    ['j28','Lantern District', 128,'l','wsgl',[2,2,1,0],4,['c:lamp:6','k:3:3'],0,0,30,0,''],
    ['j29','Meadow Rows',      129,'l','wsgpl',[2,2,1,0,0],5,['c:plant:6','k:2:5'],0,0,30,0,''],
    ['j30','Old Town',         130,'l','wsgpl',[2,2,1,0,0],6,['c:wood:6','c:stone:6','c:lamp:3','h:4'],4,44,36,2,'MASTERY: the full toolkit under a move limit.'],
    ['j31','Windy Gap',        131,'l','wsg',[1,1,0],1,['k:3:4'],6,0,26,2,''],
    ['j32','Crystal Court',    132,'l','wsgl',[1,1,0,0],4,['c:glass:6','c:lamp:4'],3,0,30,2,''],
    ['j33','Terraced Hills',   133,'l','wsgpl',[2,2,1,0,0],6,['k:2:6','c:plant:5'],4,0,34,2,''],
    ['j34','Night Watch',      134,'l','wsgl',[2,2,1,0],4,['c:lamp:8','h:4'],5,42,34,2,''],
    ['j35','Grand Atrium',     135,'l','wsgpl',[2,2,1,0,0],6,['c:glass:8','h:5','c:plant:4'],4,0,38,3,'MASTERY: height, glass, and greenery together.'],
    ['j36','Lean Season',      136,'l','wsgpl',[1,1,0,0,0],6,['c:wood:6','c:stone:5','c:lamp:2'],4,44,38,3,''],
    ['j37','Boulder Garden',   137,'l','wsgpl',[2,2,1,0,0],6,['c:plant:8','k:2:6'],6,0,40,3,''],
    ['j38','Skyline Push',     138,'l','wsg',[2,2,1],2,['h:6','k:4:3'],5,44,38,3,''],
    ['j39','Festival of Lights',139,'l','wsgpl',[2,2,1,0,0],6,['c:lamp:8','c:plant:6','k:2:5'],5,50,42,4,''],
    ['j40','Blockstead',       140,'l','wsgpl',[2,2,1,0,0],6,['h:6','c:glass:6','c:lamp:6','k:3:4'],6,56,46,4,'MASTERY: the definitive settlement. Good luck.']
  ];

  function expandLevel(row, idx) {
    var mask = row[4];
    var blocks = [];
    if (mask.indexOf('w') >= 0) blocks.push('wood');
    if (mask.indexOf('s') >= 0) blocks.push('stone');
    if (mask.indexOf('g') >= 0) blocks.push('glass');
    if (mask.indexOf('p') >= 0) blocks.push('plant');
    if (mask.indexOf('l') >= 0) blocks.push('lamp');
    var start = {};
    blocks.forEach(function (b, i) { start[b] = row[5][i] || 0; });
    return {
      id: row[0], version: CONTENT_VERSION, kind: 'journey', index: idx,
      name: row[1], seed: row[2],
      plot: SIZES[row[3]],
      blocks: blocks, start: start,
      gather: GATHERS[row[6]],
      goals: row[7].map(parseGoal),
      rocks: row[8],
      moveLimit: row[9] || 0,
      par: { moves: row[10] },
      mechanics: { undo: true, hint: true, remove: true },
      endless: false,
      theme: THEMES[row[11]].id,
      intro: row[12] || '',
      mastery: /MASTERY/.test(row[12] || '')
    };
  }

  var JOURNEY = J.map(expandLevel);

  // ---------- challenges ----------
  var CHALLENGES = [
    { id: 'c1', name: 'Tight Schedule', seed: 501, kind: 'challenge',
      plot: SIZES.m, blocks: ['wood', 'stone', 'glass'], start: { wood: 2, stone: 2, glass: 0 },
      gather: GATHERS[2], goals: [{ kind: 'count', type: 'wood', n: 5 }, { kind: 'count', type: 'stone', n: 4 }, { kind: 'height', n: 3 }],
      rocks: 0, moveLimit: 20, par: { moves: 16 },
      mechanics: { undo: false, hint: true, remove: true }, endless: false, theme: 'meadow',
      intro: 'Only 20 moves, and gathering spends them. No undo.' },
    { id: 'c2', name: 'No Demolition', seed: 502, kind: 'challenge',
      plot: SIZES.m, blocks: ['wood', 'stone', 'glass', 'lamp'], start: { wood: 2, stone: 2, glass: 0, lamp: 0 },
      gather: GATHERS[4], goals: [{ kind: 'count', type: 'lamp', n: 3 }, { kind: 'columns', h: 3, n: 2 }],
      rocks: 0, moveLimit: 0, par: { moves: 22 },
      mechanics: { undo: true, hint: true, remove: false }, endless: false, theme: 'ember',
      intro: 'The remove tool is locked. Place with care — toppers are forever.' },
    { id: 'c3', name: 'Rocky Plot', seed: 503, kind: 'challenge',
      plot: SIZES.l, blocks: ['wood', 'stone', 'glass'], start: { wood: 2, stone: 2, glass: 0 },
      gather: GATHERS[2], goals: [{ kind: 'height', n: 5 }, { kind: 'count', type: 'stone', n: 8 }],
      rocks: 8, moveLimit: 0, par: { moves: 26 },
      mechanics: { undo: true, hint: true, remove: true }, endless: false, theme: 'canyon',
      intro: 'Eight boulders crowd the plot. Build between them.' },
    { id: 'c4', name: 'Glassworks', seed: 504, kind: 'challenge',
      plot: SIZES.l, blocks: ['wood', 'stone', 'glass'], start: { wood: 1, stone: 2, glass: 0 },
      gather: GATHERS[3], goals: [{ kind: 'count', type: 'glass', n: 10 }],
      rocks: 2, moveLimit: 34, par: { moves: 28 },
      mechanics: { undo: false, hint: true, remove: true }, endless: false, theme: 'frost',
      intro: 'Ten panes of glass, lean timber, no undo.' },
    { id: 'c5', name: 'Dark Acre', seed: 505, kind: 'challenge',
      plot: SIZES.l, blocks: ['wood', 'stone', 'glass', 'plant', 'lamp'], start: { wood: 2, stone: 2, glass: 0, plant: 0, lamp: 0 },
      gather: GATHERS[6], goals: [{ kind: 'count', type: 'lamp', n: 6 }, { kind: 'columns', h: 2, n: 4 }],
      rocks: 4, moveLimit: 40, par: { moves: 32 },
      mechanics: { undo: true, hint: false, remove: true }, endless: false, theme: 'nightfall',
      intro: 'Light six lamps over a rough acre. No hints.' },
    { id: 'c6', name: 'Master Constraint', seed: 506, kind: 'challenge',
      plot: SIZES.l, blocks: ['wood', 'stone', 'glass', 'plant', 'lamp'], start: { wood: 1, stone: 1, glass: 0, plant: 0, lamp: 0 },
      gather: GATHERS[4], goals: [{ kind: 'count', type: 'wood', n: 6 }, { kind: 'count', type: 'stone', n: 6 }, { kind: 'height', n: 4 }, { kind: 'count', type: 'lamp', n: 2 }],
      rocks: 5, moveLimit: 52, par: { moves: 44 },
      mechanics: { undo: false, hint: false, remove: true }, endless: false, theme: 'nightfall',
      intro: 'Stingy gathers, a move limit, rocks, no assists. The full test.' }
  ].map(function (c) { c.version = CONTENT_VERSION; return c; });

  // ---------- practice presets ----------
  var PRACTICE = [
    { id: 'casual', name: 'Casual', seed: 301,
      plot: SIZES.s, blocks: ['wood', 'stone'], start: { wood: 3, stone: 2 },
      gather: GATHERS[0], goals: [{ kind: 'count', type: 'wood', n: 4 }, { kind: 'height', n: 2 }],
      rocks: 0, moveLimit: 0, par: { moves: 12 },
      mechanics: { undo: true, hint: true, remove: true }, endless: false },
    { id: 'apprentice', name: 'Apprentice', seed: 302,
      plot: SIZES.m, blocks: ['wood', 'stone', 'glass', 'lamp'], start: { wood: 2, stone: 2, glass: 0, lamp: 0 },
      gather: GATHERS[4], goals: [{ kind: 'count', type: 'lamp', n: 2 }, { kind: 'height', n: 3 }, { kind: 'count', type: 'glass', n: 3 }],
      rocks: 2, moveLimit: 0, par: { moves: 22 },
      mechanics: { undo: true, hint: true, remove: true }, endless: false },
    { id: 'expert', name: 'Expert', seed: 303,
      plot: SIZES.l, blocks: ['wood', 'stone', 'glass', 'plant', 'lamp'], start: { wood: 2, stone: 2, glass: 0, plant: 0, lamp: 0 },
      gather: GATHERS[6], goals: [{ kind: 'height', n: 5 }, { kind: 'count', type: 'lamp', n: 4 }, { kind: 'columns', h: 2, n: 5 }],
      rocks: 5, moveLimit: 0, par: { moves: 36 },
      mechanics: { undo: true, hint: true, remove: true }, endless: false }
  ].map(function (p) { p.version = CONTENT_VERSION; p.kind = 'practice'; return p; });

  // ---------- score chase ruleset (endless) ----------
  var SCORE_CHASE = {
    id: 'score-std', version: CONTENT_VERSION, kind: 'score', name: 'Endless Skyline', seed: 404,
    plot: SIZES.l, blocks: ['wood', 'stone', 'glass', 'plant', 'lamp'],
    start: { wood: 2, stone: 2, glass: 0, plant: 0, lamp: 0 },
    gather: GATHERS[6],
    goals: [{ kind: 'count', type: 'wood', n: 3 }],
    rocks: 3, moveLimit: 0, par: null,
    mechanics: { undo: false, hint: false, remove: true }, endless: true, theme: 'meadow',
    intro: 'Goals keep coming. Build until the plot is sealed.'
  };

  // ---------- daily ----------
  // One immutable ruleset per UTC day, derived purely from the date string.
  function dailyConfig(dateStr) {
    var seed = RNG.hashString('blockstead-daily-v' + CONTENT_VERSION + '-' + dateStr);
    var day = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
    var rot = ((day % 7) + 7) % 7;
    var full = ['wood', 'stone', 'glass', 'plant', 'lamp'];
    var nBlocks = 3 + (rot % 3); // 3..5
    var blocks = full.slice(0, nBlocks);
    var start = {};
    blocks.forEach(function (b, i) { start[b] = i < 2 ? 2 : 0; });
    var goals = [
      { kind: 'count', type: blocks[rot % nBlocks], n: 4 + (rot % 3) },
      { kind: 'height', n: 3 + (rot % 2) }
    ];
    if (rot >= 3) goals.push({ kind: 'columns', h: 2, n: 2 + (rot % 3) });
    if (blocks.indexOf('lamp') >= 0 && rot % 2 === 0) goals.push({ kind: 'count', type: 'lamp', n: 2 });
    return {
      id: 'daily-' + dateStr, version: CONTENT_VERSION, kind: 'daily',
      name: 'Daily ' + dateStr, seed: seed, date: dateStr,
      plot: SIZES[rot < 2 ? 'm' : 'l'],
      blocks: blocks, start: start,
      gather: GATHERS[[2, 3, 4, 5, 6, 6, 3][rot]],
      goals: goals,
      rocks: rot >= 4 ? 3 : rot,
      moveLimit: rot === 6 ? 40 : 0,
      par: { moves: 22 + rot * 2 },
      mechanics: { undo: true, hint: true, remove: true }, endless: false,
      theme: THEMES[rot % THEMES.length].id,
      intro: 'One shared seed for everyone, today only.'
    };
  }

  function utcDateString(nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // ---------- tutorial (Learn) ----------
  function tutorialLessons() {
    var base = {
      version: CONTENT_VERSION, kind: 'tutorial',
      plot: SIZES.s, moveLimit: 0, par: null, rocks: 0, endless: false,
      mechanics: { undo: false, hint: true, remove: true }
    };
    function cfg(over) {
      return Object.assign({}, base, over, {
        plot: over.plot || base.plot,
        mechanics: Object.assign({}, base.mechanics, over.mechanics || {})
      });
    }
    return [
      { id: 't1', title: 'Gather supplies',
        text: 'Building costs resources. Press the Gather button (or the G key) to collect timber and stone from the valley.',
        goal: { event: 'gather', count: 1 },
        cfg: cfg({ id: 't1', seed: 9001, blocks: ['wood', 'stone'], start: { wood: 0, stone: 0 },
          gather: GATHERS[0], goals: [{ kind: 'count', type: 'wood', n: 99 }] }) },
      { id: 't2', title: 'Place a block',
        text: 'Select Timber in the tray, then tap any glowing plot tile to place it. Place two blocks to finish.',
        goal: { event: 'place', count: 2 },
        cfg: cfg({ id: 't2', seed: 9002, blocks: ['wood', 'stone'], start: { wood: 2, stone: 0 },
          gather: GATHERS[0], goals: [{ kind: 'count', type: 'wood', n: 99 }] }) },
      { id: 't3', title: 'Build upward',
        text: 'Blocks stack into columns. Build a column two blocks tall to complete this stage goal.',
        goal: { event: 'win', count: 1 },
        cfg: cfg({ id: 't3', seed: 9003, blocks: ['wood', 'stone'], start: { wood: 3, stone: 0 },
          gather: GATHERS[0], goals: [{ kind: 'height', n: 2 }] }) },
      { id: 't4', title: 'Glass needs support',
        text: 'Glass cannot rest on bare soil — it needs a block beneath it. Raise a stone, then cap it with glass.',
        goal: { event: 'win', count: 1 },
        cfg: cfg({ id: 't4', seed: 9004, blocks: ['wood', 'stone', 'glass'], start: { wood: 0, stone: 1, glass: 1 },
          gather: GATHERS[2], goals: [{ kind: 'count', type: 'glass', n: 1 }] }) },
      { id: 't5', title: 'Crown it with a lamp',
        text: 'Lamps and plants are toppers: they need a solid top beneath them, and nothing stacks above. Place the lamp to win.',
        goal: { event: 'win', count: 1 },
        cfg: cfg({ id: 't5', seed: 9005, blocks: ['wood', 'stone', 'lamp'], start: { wood: 1, stone: 0, lamp: 1 },
          gather: GATHERS[4], goals: [{ kind: 'count', type: 'lamp', n: 1 }] }) },
      { id: 't6', title: 'Second chances',
        text: 'In relaxed modes you can undo (U) or remove a block (R, then tap a column). Place a block, then undo it to finish.',
        goal: { event: 'undo', count: 1 },
        cfg: cfg({ id: 't6', seed: 9006, blocks: ['wood', 'stone'], start: { wood: 2, stone: 1 },
          gather: GATHERS[0], goals: [{ kind: 'count', type: 'wood', n: 99 }],
          mechanics: { undo: true } }) }
    ];
  }

  // ---------- achievements (stable lowercase keys, idempotent) ----------
  var ACHIEVEMENTS = [
    { key: 'first-place',  name: 'First Block',     desc: 'Place your first block.' },
    { key: 'first-win',    name: 'Homesteader',     desc: 'Complete every goal in a stage.' },
    { key: 'tower-5',      name: 'Skyward',         desc: 'Raise a column five blocks tall.' },
    { key: 'blocks-500',   name: 'Master Builder',  desc: 'Place 500 blocks across all play.' },
    { key: 'journey-half', name: 'Half the Valley', desc: 'Finish 20 journey stages.' },
    { key: 'journey-done', name: 'Valley Founder',  desc: 'Finish all 40 journey stages.' },
    { key: 'daily-7',      name: 'Regular',         desc: 'Finish 7 daily challenges.' },
    { key: 'score-2500',   name: 'High Rise',       desc: 'Score 2500+ in a single round.' },
    { key: 'challenger',   name: 'Proven',          desc: 'Finish all six challenges.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    BLOCKS: BLOCKS,
    PLACEABLE: PLACEABLE,
    THEMES: THEMES,
    SIZES: SIZES,
    GATHERS: GATHERS,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE: PRACTICE,
    SCORE_CHASE: SCORE_CHASE,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dailyConfig: dailyConfig,
    utcDateString: utcDateString,
    tutorialLessons: tutorialLessons,
    parseGoal: parseGoal
  };
});
