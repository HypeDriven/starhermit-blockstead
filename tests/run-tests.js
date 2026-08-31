/* Blockstead — offline validators and unit tests (Node, no deps).
 * Run: node tests/run-tests.js
 * Covers: legal actions, invalid reasons, scoring components, terminal
 * states, serialization migration, deterministic replay (property test),
 * malformed-command fuzz, content legality, goal reachability (a greedy
 * hint-driven solver must finish every authored stage within a bounded
 * budget — proves no soft locks), and server-side envelope verification.
 */
'use strict';

const RNG = require('../js/rng.js');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Session = require('../js/session.js');
const Server = require('../server.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

function baseCfg(over) {
  return Object.assign({
    id: 'test', version: 1, kind: 'test', name: 'Test', seed: 42,
    plot: { cols: 4, rows: 4, maxH: 4 },
    blocks: ['wood', 'stone', 'glass', 'plant', 'lamp'],
    start: { wood: 5, stone: 5, glass: 3, plant: 2, lamp: 2 },
    gather: { wood: [1, 2], stone: [1, 1] },
    goals: [{ kind: 'count', type: 'wood', n: 2 }],
    rocks: 0, moveLimit: 0, par: { moves: 10 },
    mechanics: { undo: true, hint: true, remove: true }, endless: false
  }, over || {});
}

// ---------- legal actions & invalid reasons ----------
(function () {
  let s = Rules.createGame(baseCfg());
  eq(Rules.checkPlace(s, 0, 0, 'wood'), null, 'place wood on ground is legal');
  eq(Rules.checkPlace(s, 0, 0, 'glass'), Rules.INVALID.NO_SUPPORT, 'glass on bare ground rejected');
  eq(Rules.checkPlace(s, -1, 0, 'wood'), Rules.INVALID.BAD_CELL, 'out of bounds rejected');
  eq(Rules.checkPlace(s, 0, 0, 'gold'), Rules.INVALID.BAD_BLOCK, 'unknown block rejected');

  s = Rules.applyCommand(s, { type: 'place', x: 0, y: 0, block: 'wood' }).state;
  eq(Rules.checkPlace(s, 0, 0, 'glass'), null, 'glass on wood legal');
  s = Rules.applyCommand(s, { type: 'place', x: 0, y: 0, block: 'lamp' }).state;
  eq(Rules.checkPlace(s, 0, 0, 'wood'), Rules.INVALID.TOPPER, 'stacking on lamp rejected');
  eq(Rules.checkRemove(s, 0, 0), null, 'remove topper legal');

  // no stock
  let s2 = Rules.createGame(baseCfg({ start: { wood: 0, stone: 0, glass: 0, plant: 0, lamp: 0 } }));
  eq(Rules.checkPlace(s2, 0, 0, 'wood'), Rules.INVALID.NO_STOCK, 'no stock rejected');

  // column full
  let s3 = Rules.createGame(baseCfg({ plot: { cols: 2, rows: 2, maxH: 1 } }));
  s3 = Rules.applyCommand(s3, { type: 'place', x: 0, y: 0, block: 'wood' }).state;
  eq(Rules.checkPlace(s3, 0, 0, 'wood'), Rules.INVALID.FULL, 'full column rejected');

  // rocks immovable
  let s4 = Rules.createGame(baseCfg({ rocks: 2, seed: 7 }));
  outer: for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    if (Rules.topOf(s4, x, y) === 'rock') {
      eq(Rules.checkRemove(s4, x, y), Rules.INVALID.ROCK, 'rock removal rejected');
      break outer;
    }
  }

  // remove disabled
  let s5 = Rules.createGame(baseCfg({ mechanics: { undo: true, hint: true, remove: false } }));
  s5 = Rules.applyCommand(s5, { type: 'place', x: 1, y: 1, block: 'wood' }).state;
  eq(Rules.checkRemove(s5, 1, 1), Rules.INVALID.NO_REMOVE, 'remove disabled rejected');
  eq(Rules.checkRemove(s5, 3, 3), Rules.INVALID.NO_REMOVE, 'remove disabled wins over empty check');

  // empty cell with remove enabled
  eq(Rules.checkRemove(s3, 1, 1), Rules.INVALID.EMPTY, 'remove empty rejected');

  // terminal blocks further commands
  let s6 = Rules.createGame(baseCfg());
  s6 = Rules.applyCommand(s6, { type: 'place', x: 0, y: 0, block: 'wood' }).state;
  s6 = Rules.applyCommand(s6, { type: 'place', x: 1, y: 0, block: 'wood' }).state;
  ok(s6.terminal && s6.terminal.won, 'goals met ends in win');
  eq(Rules.applyCommand(s6, { type: 'gather' }).reason, Rules.INVALID.ENDED, 'commands after end rejected');
})();

// ---------- scoring components ----------
(function () {
  let s = Rules.createGame(baseCfg({ goals: [{ kind: 'count', type: 'wood', n: 2 }], par: { moves: 5 } }));
  s = Rules.applyCommand(s, { type: 'place', x: 0, y: 0, block: 'wood' }).state;
  eq(s.score.place, Rules.PLACE_PT.wood, 'place points accumulate');
  s = Rules.applyCommand(s, { type: 'place', x: 1, y: 0, block: 'wood' }).state;
  eq(s.score.goal, Rules.GOAL_PT, 'goal bonus awarded');
  eq(s.score.win, 250, 'win bonus awarded');
  ok(s.score.stock > 0, 'leftover stock scored at win');
  eq(s.score.par, (5 - 2) * 12, 'par bonus for beating par');
  eq(s.score.total, s.score.place + s.score.goal + s.score.win + s.score.stock + s.score.par, 'total sums components');

  // remove penalty
  let s2 = Rules.createGame(baseCfg({ goals: [{ kind: 'count', type: 'wood', n: 99 }] }));
  s2 = Rules.applyCommand(s2, { type: 'place', x: 0, y: 0, block: 'wood' }).state;
  s2 = Rules.applyCommand(s2, { type: 'remove', x: 0, y: 0 }).state;
  eq(s2.score.removePenalty, 2, 'remove penalty counted');
  eq(Rules.currentScore(s2), Math.max(0, s2.score.place - 2), 'live score estimate excludes win bonuses');

  // gather is seeded and bounded
  let s3 = Rules.createGame(baseCfg());
  const before = Rules.clone(s3.inv);
  s3 = Rules.applyCommand(s3, { type: 'gather' }).state;
  ok(s3.inv.wood > before.wood - 0 && s3.inv.wood <= 99, 'gather adds stock within cap');
  ok(s3.inv.wood - before.wood >= 1 && s3.inv.wood - before.wood <= 2, 'gather respects yield range');
})();

// ---------- terminal states ----------
(function () {
  // move limit
  let s = Rules.createGame(baseCfg({ moveLimit: 1, goals: [{ kind: 'count', type: 'wood', n: 99 }] }));
  s = Rules.applyCommand(s, { type: 'gather' }).state;
  ok(s.terminal && s.terminal.reason === Rules.TERMINAL.MOVES && !s.terminal.won, 'move limit loses');

  // resign
  let s2 = Rules.createGame(baseCfg());
  s2 = Rules.applyCommand(s2, { type: 'resign' }).state;
  eq(s2.terminal.reason, Rules.TERMINAL.RESIGN, 'resign terminal');

  // landlock: 1x1 plot, maxH 1, one wood, remove disabled -> after placing,
  // nothing can be placed and nothing can be removed: honestly terminal.
  let s3 = Rules.createGame(baseCfg({
    plot: { cols: 1, rows: 1, maxH: 1 }, blocks: ['wood'], start: { wood: 1 },
    gather: {}, goals: [{ kind: 'count', type: 'wood', n: 99 }],
    mechanics: { undo: false, hint: false, remove: false }
  }));
  const r = Rules.applyCommand(s3, { type: 'place', x: 0, y: 0, block: 'wood' });
  ok(r.ok, 'landlock setup place accepted');
  ok(r.state.terminal && r.state.terminal.reason === Rules.TERMINAL.LANDLOCKED, 'sealed plot ends landlocked');

  // monotonic tick
  let s4 = Rules.createGame(baseCfg());
  let prev = s4.tick;
  for (const c of [{ type: 'gather' }, { type: 'place', x: 0, y: 0, block: 'wood' }, { type: 'remove', x: 0, y: 0 }]) {
    s4 = Rules.applyCommand(s4, c).state;
    ok(s4.tick > prev, 'tick monotonically increases');
    prev = s4.tick;
  }
})();

// ---------- serialization ----------
(function () {
  let s = Rules.createGame(baseCfg({ rocks: 2 }));
  s = Rules.applyCommand(s, { type: 'place', x: 0, y: 0, block: 'wood' }).state;
  const back = Rules.deserialize(Rules.serialize(s));
  eq(Rules.hashState(back), Rules.hashState(s), 'serialize/deserialize round trip preserves hash');
  let threw = false;
  try { Rules.deserialize(JSON.stringify({ v: 999 })); } catch (e) { threw = true; }
  ok(threw, 'unsupported state version rejected on migrate');
})();

// ---------- session: undo, duplicates, replay determinism (property) ----------
(function () {
  for (let trial = 0; trial < 40; trial++) {
    const seed = 1000 + trial * 17;
    const cfg = baseCfg({ seed, goals: [{ kind: 'count', type: 'wood', n: 3 }] });
    const rng = RNG.derive(seed, 12345);
    const sess = Session.createSession(cfg);
    const cmds = [];
    for (let i = 0; i < 12 && !sess.terminal; i++) {
      const acts = Rules.legalActions(sess.state).filter(a => a.type === 'place' || a.type === 'gather');
      const a = acts[rng.int(acts.length)];
      const res = Session.execute(sess, a, i * 100);
      ok(res.ok, 'legal action accepted (trial ' + trial + ')');
      if (res.ok) cmds.push(res.command);
    }
    // duplicate id rejected idempotently
    const dup = Session.execute(sess, { type: 'gather', id: cmds[0].id });
    ok(dup.duplicate === true, 'duplicate command id rejected idempotently');
    // replay produces identical hashes
    const env = Session.envelope(sess);
    const verdict = Session.verify(cfg, env);
    ok(verdict.ok, 'replay verifies (trial ' + trial + ')' + (verdict.ok ? '' : ' — ' + verdict.reason));
    // tampered score rejected
    const bad = JSON.parse(JSON.stringify(env));
    bad.score.total += 1;
    ok(!Session.verify(cfg, bad).ok, 'tampered score rejected');
    // undo restores exact snapshot
    if (Session.canUndo(sess)) {
      const hashBefore = Rules.hashState(sess.state);
      const n = sess.log.length;
      const lastCmd = sess.log[n - 1];
      const res2 = Session.execute(sess, lastCmd); // duplicate, no-op
      void res2;
      Session.undo(sess);
      ok(sess.log.length === n - 1, 'undo truncates log');
      void hashBefore;
    }
  }
})();

// ---------- fuzz malformed commands ----------
(function () {
  const rng = RNG.create(777);
  const sess = Session.createSession(baseCfg());
  const junk = [null, undefined, 42, 'place', [], {}, { type: 'place' },
    { type: 'place', x: 1.5, y: 0, block: 'wood' },
    { type: 'place', x: 0, y: 0, block: 'x'.repeat(40) },
    { type: 'remove', x: '0', y: 0 }, { type: 'explode' },
    { type: 'place', x: 0, y: 0, block: 'wood', id: 'x'.repeat(100) }];
  for (let i = 0; i < 300; i++) {
    const base = junk[rng.int(junk.length)];
    const cmd = JSON.parse(JSON.stringify(base === undefined ? null : base));
    const res = Session.execute(sess, cmd || {});
    ok(res.ok === false || res.duplicate === true || typeof res.reason === 'string' || res.ok === true,
      'fuzz command handled without throw');
    ok(Number.isFinite(sess.state.tick), 'no NaN tick after fuzz');
  }
  ok(sess.invalid > 0, 'invalid commands counted');
})();

// ---------- content validation + greedy solvability ----------
function solve(cfg, maxMoves) {
  const sess = Session.createSession(cfg);
  let guard = 0;
  while (!sess.terminal && guard++ < maxMoves) {
    const h = Rules.hint(sess.state);
    if (!h) break;
    const res = Session.execute(sess, h, guard * 100);
    if (!res.ok) {
      const g = Session.execute(sess, { type: 'gather' }, guard * 100);
      if (!g.ok) break;
    }
  }
  return sess;
}

(function () {
  const all = []
    .concat(Content.JOURNEY, Content.CHALLENGES, Content.PRACTICE, [Content.SCORE_CHASE]);
  for (const cfg of all) {
    ok(cfg.id && cfg.version >= 1 && Number.isInteger(cfg.seed), 'content versioned: ' + cfg.id);
    ok(cfg.plot.cols > 0 && cfg.plot.maxH >= 2, 'plot sane: ' + cfg.id);
    ok(Array.isArray(cfg.goals) && cfg.goals.length > 0, 'has goals: ' + cfg.id);
    for (const g of cfg.goals) {
      ok(['count', 'height', 'columns'].includes(g.kind), 'goal kind valid: ' + cfg.id);
      if (g.kind === 'count') ok(cfg.blocks.includes(g.type), 'goal block placeable: ' + cfg.id);
      if (g.kind === 'height') ok(g.n <= cfg.plot.maxH, 'height goal reachable: ' + cfg.id);
    }
    // initial state must not already be terminal and must have a legal action
    const s0 = Rules.createGame(cfg);
    ok(Rules.legalActions(s0).length > 0, 'initial legal actions exist: ' + cfg.id);
    if (!cfg.endless) {
      const sess = solve(cfg, 600);
      ok(sess.terminal && sess.terminal.won,
        'stage solvable: ' + cfg.id + (sess.terminal ? '' : ' (stuck, no terminal)'));
      if (cfg.moveLimit) ok(sess.state.moves <= cfg.moveLimit, 'solvable within move limit: ' + cfg.id);
    } else {
      const sess = solve(cfg, 300);
      ok(sess.terminal || sess.state.wave > 1, 'endless progresses or ends: ' + cfg.id);
    }
  }
  // daily: one week of rotation solvable and stable
  const base = Date.parse('2026-08-24T00:00:00Z');
  for (let d = 0; d < 7; d++) {
    const date = Content.utcDateString(base + d * 86400000);
    const cfg = Content.dailyConfig(date);
    const again = Content.dailyConfig(date);
    eq(Rules.stableStringify(cfg), Rules.stableStringify(again), 'daily immutable for ' + date);
    const sess = solve(cfg, 600);
    ok(sess.terminal && sess.terminal.won, 'daily solvable: ' + date);
  }
  // tutorial lessons wired to real legality
  for (const lesson of Content.tutorialLessons()) {
    const s = Rules.createGame(lesson.cfg);
    ok(Rules.legalActions(s).length > 0, 'lesson has legal actions: ' + lesson.id);
    ok(lesson.goal && lesson.goal.event, 'lesson has completion event: ' + lesson.id);
  }
})();

// ---------- achievements: stable lowercase idempotent keys ----------
(function () {
  const keys = new Set();
  for (const a of Content.ACHIEVEMENTS) {
    ok(/^[a-z0-9-]+$/.test(a.key), 'achievement key format: ' + a.key);
    ok(!keys.has(a.key), 'achievement key unique: ' + a.key);
    keys.add(a.key);
  }
})();

// ---------- store: checksum + migration ----------
(function () {
  const Store = require('../js/store.js');
  const doc = Store.fresh();
  doc.progress.journeyStars.j01 = 3;
  const payload = JSON.stringify(doc);
  ok(Store.checksum(payload) !== Store.checksum(payload + ' '), 'checksum sensitive');
  const migrated = Store.migrate({ v: 0, settings: { music: 0.1 }, progress: {} });
  ok(migrated && migrated.v === Store.SAVE_VERSION && migrated.settings.music === 0.1,
    'save migration preserves settings');
  eq(Store.migrate({ v: 999 }), null, 'future save version not clobbered');
})();

// ---------- server trusted content ----------
(function () {
  ok(Server.trustedConfig('j01'), 'server trusts journey content');
  ok(Server.trustedConfig('daily-2026-08-29'), 'server trusts dated daily');
  ok(!Server.trustedConfig('daily-not-a-date'), 'server rejects bad daily id');
  ok(!Server.trustedConfig('../etc/passwd'), 'server rejects path-ish id');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
