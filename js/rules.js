/* Blockstead — pure deterministic rules engine.
 * No rendering, no DOM, no Date.now(): every transition derives from
 * (state, command) only. Usable from browser (window.BSRules) and Node.
 *
 * Core loop: gather resources, place blocks on a voxel plot, remove
 * mistakes, and complete the build goals. Rocks are immovable terrain.
 * Glass needs support; lamps and plants are toppers (nothing stacks on
 * them). You win by finishing every goal; you lose by running out of
 * moves or landlocking the plot.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.BSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSRules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STATE_VERSION = 1;

  var PLACE_PT = { wood: 5, stone: 7, glass: 10, plant: 9, lamp: 14 };
  var GOAL_PT = 150;         // per goal completed
  var WIN_PT = 250;          // flat win bonus
  var STOCK_PT = 3;          // per leftover resource at win
  var PAR_PT = 12;           // per move under par at win
  var REMOVE_PENALTY = 2;    // per removed block
  var INV_CAP = 99;

  // Blocks nothing can be stacked upon (and which need a solid top below).
  var TOPPERS = { lamp: true, plant: true };
  // Blocks that cannot sit on bare ground (need a supporting block below).
  var NEEDS_SUPPORT = { glass: true, lamp: true, plant: true };

  var TERMINAL = {
    GOALS: 'goals-met',
    MOVES: 'move-limit',
    LANDLOCKED: 'landlocked',
    RESIGN: 'resigned'
  };

  var INVALID = {
    ENDED: 'game-ended',
    BAD_CMD: 'unknown-command',
    BAD_SHAPE: 'malformed-command',
    BAD_CELL: 'bad-cell',
    BAD_BLOCK: 'block-not-allowed',
    NO_STOCK: 'no-resource',
    FULL: 'column-full',
    NO_SUPPORT: 'needs-support',
    TOPPER: 'topper-blocks-stacking',
    ROCK: 'rock-is-immovable',
    EMPTY: 'nothing-to-remove',
    NO_REMOVE: 'remove-disabled'
  };

  // ---------- helpers ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Stable stringify: object keys sorted recursively → canonical hashing.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = '[';
      for (var i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
      return out + ']';
    }
    var keys = Object.keys(v).sort(), s = '{';
    for (var k = 0; k < keys.length; k++) {
      s += (k ? ',' : '') + JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]);
    }
    return s + '}';
  }

  function hashState(state) {
    var copy = clone(state);
    delete copy.events;
    return RNG.hashString(stableStringify(copy));
  }

  function inBounds(cfg, x, y) {
    return Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && x < cfg.plot.cols && y >= 0 && y < cfg.plot.rows;
  }

  function stack(state, x, y) { return state.grid[y][x]; }
  function topOf(state, x, y) {
    var st = stack(state, x, y);
    return st.length ? st[st.length - 1] : null;
  }

  // Placed (non-rock) block count in one column.
  function builtHeight(state, x, y) {
    var st = stack(state, x, y), n = 0;
    for (var i = 0; i < st.length; i++) if (st[i] !== 'rock') n++;
    return n;
  }

  function countType(state, type) {
    var n = 0;
    for (var y = 0; y < state.cfg.plot.rows; y++)
      for (var x = 0; x < state.cfg.plot.cols; x++) {
        var st = state.grid[y][x];
        for (var i = 0; i < st.length; i++) if (st[i] === type) n++;
      }
    return n;
  }

  function maxBuiltHeight(state) {
    var m = 0;
    for (var y = 0; y < state.cfg.plot.rows; y++)
      for (var x = 0; x < state.cfg.plot.cols; x++)
        m = Math.max(m, builtHeight(state, x, y));
    return m;
  }

  function columnsAtLeast(state, h) {
    var n = 0;
    for (var y = 0; y < state.cfg.plot.rows; y++)
      for (var x = 0; x < state.cfg.plot.cols; x++)
        if (builtHeight(state, x, y) >= h) n++;
    return n;
  }

  // ---------- goals ----------

  // goal: {kind:'count', type, n} | {kind:'height', n} | {kind:'columns', h, n}
  function goalProgress(state, goal) {
    var have = 0;
    if (goal.kind === 'count') have = countType(state, goal.type);
    else if (goal.kind === 'height') have = maxBuiltHeight(state);
    else if (goal.kind === 'columns') have = columnsAtLeast(state, goal.h);
    return { have: Math.min(have, goal.n), need: goal.n, done: have >= goal.n };
  }

  function allGoalsDone(state) {
    for (var i = 0; i < state.cfg.goals.length; i++)
      if (!goalProgress(state, state.cfg.goals[i]).done) return false;
    return true;
  }

  // ---------- game creation ----------

  // cfg: { id, version, kind, name, seed,
  //        plot:{cols,rows,maxH}, blocks:[types], start:{type:n},
  //        gather:{type:[lo,hi]}, goals:[...], rocks:n,
  //        moveLimit, par:{moves} | null,
  //        mechanics:{undo,hint,remove}, endless, theme, intro }
  function createGame(cfg) {
    if (!cfg || !cfg.plot || !cfg.plot.cols || !cfg.plot.rows || !cfg.plot.maxH)
      throw new Error('bad plot config');
    if (!Array.isArray(cfg.goals) || !cfg.goals.length)
      throw new Error('config needs at least one goal');
    var seed = cfg.seed >>> 0;
    var rng = RNG.derive(seed, RNG.STREAM_RULES);

    var grid = [];
    for (var y = 0; y < cfg.plot.rows; y++) {
      var row = [];
      for (var x = 0; x < cfg.plot.cols; x++) row.push([]);
      grid.push(row);
    }

    // Seeded rock terrain. Rocks never cover more than a third of the plot
    // and never spawn directly under the exact center cell (keeps an obvious
    // first building spot on every layout).
    var cells = [];
    for (y = 0; y < cfg.plot.rows; y++)
      for (x = 0; x < cfg.plot.cols; x++) {
        var cx = (cfg.plot.cols - 1) / 2, cy = (cfg.plot.rows - 1) / 2;
        if (Math.abs(x - cx) < 1 && Math.abs(y - cy) < 1) continue;
        cells.push([x, y]);
      }
    rng.shuffle(cells);
    var nRocks = Math.min(cfg.rocks || 0, Math.floor(cells.length / 3));
    for (var r = 0; r < nRocks; r++) {
      var cell = cells[r];
      var rh = rng.range(1, Math.min(2, cfg.plot.maxH - 2));
      for (var i = 0; i < rh; i++) grid[cell[1]][cell[0]].push('rock');
    }

    var inv = {};
    (cfg.blocks || []).forEach(function (t) { inv[t] = (cfg.start && cfg.start[t]) || 0; });

    var state = {
      v: STATE_VERSION,
      cfg: clone(cfg),
      seed: seed,
      rngState: rng.state,
      tick: 0,
      moves: 0,
      grid: grid,
      inv: inv,
      gathered: 0,
      placed: 0,
      removed: 0,
      wave: 1,
      goalsDone: (cfg.goals || []).map(function () { return false; }),
      score: { place: 0, goal: 0, win: 0, stock: 0, par: 0, removePenalty: 0, waves: 0, total: 0 },
      elapsedMs: 0,
      terminal: null,
      events: []
    };
    return state;
  }

  // ---------- legality ----------

  function checkPlace(state, x, y, block) {
    if (state.terminal) return INVALID.ENDED;
    if (!inBounds(state.cfg, x, y)) return INVALID.BAD_CELL;
    if (state.cfg.blocks.indexOf(block) < 0) return INVALID.BAD_BLOCK;
    if ((state.inv[block] || 0) <= 0) return INVALID.NO_STOCK;
    var st = stack(state, x, y);
    if (st.length >= state.cfg.plot.maxH) return INVALID.FULL;
    var top = st.length ? st[st.length - 1] : null;
    if (top && TOPPERS[top]) return INVALID.TOPPER;
    if (NEEDS_SUPPORT[block] && (!top || top === 'rock')) return INVALID.NO_SUPPORT;
    return null;
  }

  function checkRemove(state, x, y) {
    if (state.terminal) return INVALID.ENDED;
    if (state.cfg.mechanics && state.cfg.mechanics.remove === false) return INVALID.NO_REMOVE;
    if (!inBounds(state.cfg, x, y)) return INVALID.BAD_CELL;
    var st = stack(state, x, y);
    if (!st.length) return INVALID.EMPTY;
    if (st[st.length - 1] === 'rock') return INVALID.ROCK;
    return null;
  }

  function checkGather(state) {
    if (state.terminal) return INVALID.ENDED;
    if (!state.cfg.gather || !Object.keys(state.cfg.gather).length) return INVALID.BAD_CMD;
    return null;
  }

  function canAnyPlace(state) {
    for (var b = 0; b < state.cfg.blocks.length; b++) {
      var block = state.cfg.blocks[b];
      if ((state.inv[block] || 0) <= 0) continue;
      for (var y = 0; y < state.cfg.plot.rows; y++)
        for (var x = 0; x < state.cfg.plot.cols; x++)
          if (checkPlace(state, x, y, block) === null) return true;
    }
    return false;
  }

  function canAnyRemove(state) {
    if (state.cfg.mechanics && state.cfg.mechanics.remove === false) return false;
    for (var y = 0; y < state.cfg.plot.rows; y++)
      for (var x = 0; x < state.cfg.plot.cols; x++)
        if (checkRemove(state, x, y) === null) return true;
    return false;
  }

  // Full legal-action surface; tutorials and hints use exactly this.
  function legalActions(state) {
    if (state.terminal) return [];
    var acts = [];
    if (checkGather(state) === null) acts.push({ type: 'gather' });
    for (var y = 0; y < state.cfg.plot.rows; y++)
      for (var x = 0; x < state.cfg.plot.cols; x++) {
        for (var b = 0; b < state.cfg.blocks.length; b++) {
          var block = state.cfg.blocks[b];
          if (checkPlace(state, x, y, block) === null) acts.push({ type: 'place', x: x, y: y, block: block });
        }
        if (checkRemove(state, x, y) === null) acts.push({ type: 'remove', x: x, y: y });
      }
    return acts;
  }

  // Columns where the given block may legally be placed (for target preview).
  function legalTargets(state, block) {
    var out = [];
    if (state.terminal) return out;
    for (var y = 0; y < state.cfg.plot.rows; y++)
      for (var x = 0; x < state.cfg.plot.cols; x++)
        if (checkPlace(state, x, y, block) === null) out.push({ x: x, y: y });
    return out;
  }

  // ---------- resolution ----------

  function applyCommand(state, cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      return { ok: false, reason: INVALID.BAD_SHAPE, state: state, events: [] };
    }
    if (state.terminal) {
      return { ok: false, reason: INVALID.ENDED, state: state, events: [] };
    }
    if (cmd.type === 'resign') {
      var rs = clone(state);
      rs.tick++;
      rs.events = [];
      rs.terminal = { reason: TERMINAL.RESIGN, won: false };
      rs.events.push({ type: 'lose', reason: TERMINAL.RESIGN });
      finalizeScore(rs);
      return { ok: true, state: rs, events: rs.events };
    }
    if (cmd.type === 'gather') return doGather(state, cmd);
    if (cmd.type === 'place') return doPlace(state, cmd);
    if (cmd.type === 'remove') return doRemove(state, cmd);
    return { ok: false, reason: INVALID.BAD_CMD, state: state, events: [] };
  }

  function beginStep(state, cmd) {
    var s = clone(state);
    s.events = [];
    s.tick++;
    s.moves++;
    if (typeof cmd.atMs === 'number' && isFinite(cmd.atMs) && cmd.atMs >= 0) {
      s.elapsedMs = Math.floor(cmd.atMs / 100) * 100; // quantized, replay-safe
    }
    return s;
  }

  function doGather(state, cmd) {
    var reason = checkGather(state);
    if (reason) return { ok: false, reason: reason, state: state, events: [] };
    var s = beginStep(state, cmd);
    var rng = RNG.create(s.rngState);
    var gains = {};
    for (var t in s.cfg.gather) {
      var range = s.cfg.gather[t];
      var n = rng.range(range[0], range[1]);
      if (n > 0 && s.cfg.blocks.indexOf(t) >= 0) {
        s.inv[t] = Math.min(INV_CAP, (s.inv[t] || 0) + n);
        gains[t] = n;
      }
    }
    s.gathered++;
    s.events.push({ type: 'gather', gains: gains });
    s.rngState = rng.state;
    endStep(s);
    return { ok: true, state: s, events: s.events };
  }

  function doPlace(state, cmd) {
    var reason = checkPlace(state, cmd.x, cmd.y, cmd.block);
    if (reason) return { ok: false, reason: reason, state: state, events: [] };
    var s = beginStep(state, cmd);
    s.inv[cmd.block]--;
    stack(s, cmd.x, cmd.y).push(cmd.block);
    s.placed++;
    var pts = PLACE_PT[cmd.block] || 5;
    s.score.place += pts;
    s.events.push({
      type: 'place', block: cmd.block, x: cmd.x, y: cmd.y,
      h: stack(s, cmd.x, cmd.y).length, points: pts
    });
    endStep(s);
    return { ok: true, state: s, events: s.events };
  }

  function doRemove(state, cmd) {
    var reason = checkRemove(state, cmd.x, cmd.y);
    if (reason) return { ok: false, reason: reason, state: state, events: [] };
    var s = beginStep(state, cmd);
    var st = stack(s, cmd.x, cmd.y);
    var block = st.pop();
    s.removed++;
    s.score.removePenalty += REMOVE_PENALTY;
    s.events.push({ type: 'remove', block: block, x: cmd.x, y: cmd.y, h: st.length });
    endStep(s);
    return { ok: true, state: s, events: s.events };
  }

  // Goal evaluation + terminal resolution shared by all mutating commands.
  function endStep(s) {
    // Goals (re-evaluated after every action; completion is monotonic —
    // a met goal stays met even if blocks are later removed).
    for (var i = 0; i < s.cfg.goals.length; i++) {
      if (s.goalsDone[i]) continue;
      if (goalProgress(s, s.cfg.goals[i]).done) {
        s.goalsDone[i] = true;
        s.score.goal += GOAL_PT;
        s.events.push({ type: 'goal', index: i, goal: clone(s.cfg.goals[i]) });
      }
    }

    if (allGoalsDone(s)) {
      if (s.cfg.endless) {
        s.score.waves++;
        s.wave++;
        s.events.push({ type: 'wave', wave: s.wave });
        var rng = RNG.create(s.rngState);
        s.cfg.goals = nextWaveGoals(s, rng);
        s.goalsDone = s.cfg.goals.map(function () { return false; });
        s.rngState = rng.state;
        s.events.push({ type: 'goals-new', goals: clone(s.cfg.goals) });
      } else {
        s.terminal = { reason: TERMINAL.GOALS, won: true };
        s.score.win = WIN_PT;
        var stock = 0;
        for (var t in s.inv) stock += s.inv[t];
        s.score.stock = stock * STOCK_PT;
        if (s.cfg.par && s.cfg.par.moves && s.moves < s.cfg.par.moves) {
          s.score.par = (s.cfg.par.moves - s.moves) * PAR_PT;
        }
        s.events.push({ type: 'win', reason: TERMINAL.GOALS });
      }
    }

    if (!s.terminal && s.cfg.moveLimit && s.moves >= s.cfg.moveLimit) {
      s.terminal = { reason: TERMINAL.MOVES, won: false };
      s.events.push({ type: 'lose', reason: TERMINAL.MOVES });
    }

    // Landlock guard: no legal placement and no way to free space.
    // Proves the absence of soft locks — every non-terminal state has a
    // legal action (gather always remains available, but it cannot help a
    // sealed plot, so the round honestly ends instead of hanging).
    if (!s.terminal && !canAnyPlace(s) && !canAnyRemove(s)) {
      s.terminal = { reason: TERMINAL.LANDLOCKED, won: false };
      s.events.push({ type: 'lose', reason: TERMINAL.LANDLOCKED });
    }

    if (s.terminal) finalizeScore(s);
  }

  // Endless score-chase waves: 2–3 goals that scale with the wave number.
  function nextWaveGoals(s, rng) {
    var types = s.cfg.blocks;
    var goals = [];
    var w = s.wave;
    var t = rng.pick(types);
    goals.push({ kind: 'count', type: t, n: 2 + w });
    if (rng.next() < 0.7) {
      goals.push({ kind: 'height', n: Math.min(2 + Math.floor(w / 2), s.cfg.plot.maxH - 1) });
    } else {
      goals.push({ kind: 'columns', h: 2, n: Math.min(1 + Math.ceil(w / 2), s.cfg.plot.cols * s.cfg.plot.rows - 2) });
    }
    if (w >= 3 && types.indexOf('lamp') >= 0 && rng.next() < 0.5) {
      goals.push({ kind: 'count', type: 'lamp', n: 1 + Math.floor(w / 3) });
    }
    return goals;
  }

  function finalizeScore(s) {
    s.score.total = s.score.place + s.score.goal + s.score.win +
      s.score.stock + s.score.par - s.score.removePenalty;
    if (s.score.total < 0) s.score.total = 0;
  }

  // Live score estimate for the HUD (before terminal finalize).
  function currentScore(s) {
    var stock = 0;
    for (var t in s.inv) stock += s.inv[t];
    return Math.max(0, s.score.place + s.score.goal +
      (s.terminal ? s.score.win + s.score.stock + s.score.par : 0) - s.score.removePenalty);
  }

  // ---------- hints (same legality surface as play) ----------

  function hint(state) {
    if (state.terminal) return null;
    // 1) place toward an unmet goal when we hold the needed stock.
    for (var i = 0; i < state.cfg.goals.length; i++) {
      var g = state.cfg.goals[i];
      if (goalProgress(state, g).done) continue;
      var block = null, cells = null, why = null;
      if (g.kind === 'count' && state.cfg.blocks.indexOf(g.type) >= 0) {
        block = g.type; cells = legalTargets(state, block); why = 'goal-count';
      } else if (g.kind === 'height') {
        block = pickStackable(state);
        cells = block ? tallestLegal(state, block) : null; why = 'goal-height';
      } else if (g.kind === 'columns') {
        block = pickStackable(state);
        cells = block ? shortestLegal(state, block, g.h) : null; why = 'goal-columns';
      }
      if (block && (state.inv[block] || 0) > 0 && cells && cells.length) {
        return { type: 'place', x: cells[0].x, y: cells[0].y, block: block, why: why, goal: i };
      }
      if (block && (state.inv[block] || 0) <= 0 && checkGather(state) === null) {
        return { type: 'gather', why: 'need-' + block, goal: i };
      }
    }
    // 2) goals met is impossible here; fall back to any legal place.
    var acts = legalActions(state);
    for (var a = 0; a < acts.length; a++) if (acts[a].type === 'place') {
      return { type: 'place', x: acts[a].x, y: acts[a].y, block: acts[a].block, why: 'any' };
    }
    if (acts.length) return { type: acts[0].type, x: acts[0].x, y: acts[0].y, why: 'any' };
    return null;
  }

  function pickStackable(state) {
    // Prefer a non-topper block we hold (toppers end a stack).
    var pref = ['stone', 'wood', 'glass'];
    for (var i = 0; i < pref.length; i++) {
      var b = pref[i];
      if (state.cfg.blocks.indexOf(b) >= 0 && (state.inv[b] || 0) > 0) return b;
    }
    for (i = 0; i < state.cfg.blocks.length; i++) {
      b = state.cfg.blocks[i];
      if (!TOPPERS[b] && (state.inv[b] || 0) > 0) return b;
    }
    return null;
  }

  function tallestLegal(state, block) {
    var cells = legalTargets(state, block);
    cells.sort(function (a, b2) { return stack(state, b2.x, b2.y).length - stack(state, a.x, a.y).length; });
    return cells;
  }
  function shortestLegal(state, block, h) {
    var cells = legalTargets(state, block).filter(function (c) {
      return builtHeight(state, c.x, c.y) < h;
    });
    cells.sort(function (a, b2) { return stack(state, b2.x, b2.y).length - stack(state, a.x, a.y).length; });
    return cells;
  }

  // ---------- validation (network / replay boundary) ----------

  function validateCommandShape(cmd, maxLen) {
    if (!cmd || typeof cmd !== 'object') return INVALID.BAD_SHAPE;
    if (JSON.stringify(cmd).length > (maxLen || 512)) return INVALID.BAD_SHAPE;
    if (['gather', 'place', 'remove', 'resign'].indexOf(cmd.type) < 0) return INVALID.BAD_CMD;
    if (cmd.id != null && (typeof cmd.id !== 'string' || cmd.id.length > 64)) return INVALID.BAD_SHAPE;
    if (cmd.type === 'place') {
      if (!Number.isInteger(cmd.x) || !Number.isInteger(cmd.y)) return INVALID.BAD_SHAPE;
      if (typeof cmd.block !== 'string' || cmd.block.length > 16) return INVALID.BAD_SHAPE;
    }
    if (cmd.type === 'remove') {
      if (!Number.isInteger(cmd.x) || !Number.isInteger(cmd.y)) return INVALID.BAD_SHAPE;
    }
    return null;
  }

  // ---------- serialization ----------

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (s.v !== STATE_VERSION) throw new Error('unsupported state version ' + s.v);
    return s;
  }

  return {
    STATE_VERSION: STATE_VERSION,
    TERMINAL: TERMINAL,
    INVALID: INVALID,
    PLACE_PT: PLACE_PT,
    GOAL_PT: GOAL_PT,
    TOPPERS: TOPPERS,
    NEEDS_SUPPORT: NEEDS_SUPPORT,
    createGame: createGame,
    applyCommand: applyCommand,
    checkPlace: checkPlace,
    checkRemove: checkRemove,
    checkGather: checkGather,
    legalActions: legalActions,
    legalTargets: legalTargets,
    hint: hint,
    goalProgress: goalProgress,
    allGoalsDone: allGoalsDone,
    countType: countType,
    maxBuiltHeight: maxBuiltHeight,
    builtHeight: builtHeight,
    topOf: topOf,
    currentScore: currentScore,
    hashState: hashState,
    stableStringify: stableStringify,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone,
    validateCommandShape: validateCommandShape
  };
});
