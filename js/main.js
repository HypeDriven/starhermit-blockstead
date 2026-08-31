/* Blockstead — bootstrap + game controller (ES module).
 * Owns the state machine:
 *   boot → title → profile-ready → mode-select → preparing →
 *   tutorial/countdown → active ↔ paused → resolving → results → progression
 * Only this module issues validated commands into the session layer.
 */
import { createRenderer } from './render.js';

(function () {
  'use strict';

  const Rules = window.BSRules;
  const Content = window.BSContent;
  const Store = window.BSStore;
  const Session = window.BSSession;
  const UI = window.BSUI;
  const Audio = window.BSAudio;
  const RNG = window.BSRNG;

  // ---------- persistent doc ----------
  let doc = Store.load();
  let settings = doc.settings;
  let progress = doc.progress;
  function persist() { doc.settings = settings; doc.progress = progress; Store.save(doc); }

  // anonymous local-only funnel counters (no network, no text)
  progress.stats.funnel = progress.stats.funnel || {};
  function funnel(key) {
    progress.stats.funnel[key] = (progress.stats.funnel[key] || 0) + 1;
    persist();
  }

  const sessionId = 's' + Math.random().toString(36).slice(2, 10);
  let playerName = 'Guest-' + sessionId.slice(1, 5);

  // ---------- platform time (round-trip adjusted, offline fallback) ----------
  let timeOffset = 0, hosted = false;
  function nowMs() { return Date.now() + timeOffset; }
  async function syncTime() {
    try {
      const t0 = Date.now();
      const r = await fetch('/api/v1/time', { cache: 'no-store' });
      const t1 = Date.now();
      if (!r.ok) return;
      const j = await r.json();
      timeOffset = j.now - Math.round((t0 + t1) / 2);
      hosted = true;
    } catch (e) { hosted = false; }
  }

  // ---------- renderer ----------
  let renderer = null, webglOk = true;
  function qualityTier() {
    if (settings.graphicsTier !== 'auto') return settings.graphicsTier;
    const coarse = matchMedia('(pointer:coarse)').matches;
    const small = Math.min(screen.width, screen.height) < 820;
    return (coarse || small) ? 'medium' : 'high';
  }
  function bootRenderer() {
    try {
      renderer = createRenderer({
        host: document.getElementById('scene-host'),
        quality: qualityTier(),
        reducedMotion: settings.reducedMotion,
        onPick: onCellPicked,
        onHover: onCellHover,
        onContextLost: () => { webglOk = false; UI.webglFallback(true); }
      });
    } catch (e) { renderer = null; }
    webglOk = !!renderer;
    if (!renderer && round.state) {
      UI.webglFallback(true);
      settings.boardMirror = true;
    }
    applyVisualSettings();
  }

  function themeById(id) {
    return Content.THEMES.find(t => t.id === id) || Content.THEMES[0];
  }
  function applyVisualSettings() {
    document.body.classList.toggle('reduced-motion', !!settings.reducedMotion);
    document.body.classList.toggle('high-contrast', !!settings.highContrast);
    document.body.classList.toggle('large-text', !!settings.largeText);
    document.body.classList.toggle('left-handed', !!settings.leftHanded);
    if (renderer) {
      renderer.setReducedMotion(settings.reducedMotion);
      const themeId = (round.state && round.state.cfg.theme) || settings.theme;
      renderer.setPalette(themeById(themeId).palette, settings.highContrast || settings.colorPalette === 'high-visibility');
      renderer.setQuality(qualityTier());
    }
    Audio.applySettings(settings);
    Audio.setCaptions(!!settings.captions, UI.caption);
  }

  // ---------- round/session state ----------
  const round = {
    phase: 'boot',        // title | setup | countdown | active | paused | resolving | results
    session: null,
    state: null,
    mode: null,           // learn|journey|daily|practice|challenge|score
    levelIndex: -1,
    lesson: null, lessonEvents: {},
    selectedBlock: null,
    removeMode: false,
    pendingCell: null,    // confirm-moves assist
    focusTargets: [], focusIndex: -1,
    startedAt: 0, pausedAt: 0,
    practiceId: 'casual',
    invalidFlash: 0
  };

  // ---------- weather (cosmetic, seeded per round) ----------
  let weatherTimer = null, weatherOrder = [];
  function startWeather(seed) {
    stopWeather();
    const rng = RNG.derive(seed, 0x51ed270b);
    weatherOrder = ['sun'];
    for (let i = 0; i < 5; i++) weatherOrder.push(rng.pick(['sun', 'sun', 'cloud', 'rain']));
    let step = 0;
    const tick = () => {
      step = (step + 1) % weatherOrder.length;
      const w = weatherOrder[step];
      if (renderer) renderer.setWeather(w);
      Audio.setWeather(w);
      if (w === 'rain') Audio.play('weather-rain');
    };
    weatherTimer = setInterval(tick, 40000);
  }
  function stopWeather() { if (weatherTimer) clearInterval(weatherTimer); weatherTimer = null; }

  // ---------- helpers ----------
  function goalLabel(g) {
    const B = Content.BLOCKS;
    if (g.kind === 'count') return 'Place ' + (B[g.type] ? B[g.type].label : g.type);
    if (g.kind === 'height') return 'Tallest column height';
    return 'Columns of height ' + g.h + '+';
  }
  function goalsView(state) {
    return state.cfg.goals.map((g, i) => {
      const p = Rules.goalProgress(state, g);
      return { label: goalLabel(g), have: p.have, need: p.need, done: state.goalsDone[i] || p.done };
    });
  }
  function movesText(state) {
    return state.cfg.moveLimit ? ('Moves ' + state.moves + '/' + state.cfg.moveLimit) : ('Moves ' + state.moves);
  }
  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function legalCellSet() {
    const set = new Set();
    if (!round.state || round.state.terminal) return set;
    if (round.removeMode) {
      for (let y = 0; y < round.state.cfg.plot.rows; y++)
        for (let x = 0; x < round.state.cfg.plot.cols; x++)
          if (Rules.checkRemove(round.state, x, y) === null) set.add(x + ',' + y);
    } else if (round.selectedBlock) {
      Rules.legalTargets(round.state, round.selectedBlock).forEach(c => set.add(c.x + ',' + c.y));
    }
    return set;
  }

  function refreshUI(events) {
    const s = round.state;
    if (!s) return;
    UI.setHud({
      visible: round.phase === 'active' || round.phase === 'paused',
      modeName: s.cfg.name || s.cfg.id,
      timerText: fmtClock(s.elapsedMs),
      score: Rules.currentScore(s),
      movesText: movesText(s),
      canUndo: Session.canUndo(round.session),
      canHint: !!(s.cfg.mechanics && s.cfg.mechanics.hint !== false) && !s.terminal,
      removeMode: round.removeMode,
      removeAllowed: !(s.cfg.mechanics && s.cfg.mechanics.remove === false)
    });
    UI.setGoals(goalsView(s));
    UI.setPalette(s.cfg.blocks, s.inv, round.selectedBlock, Content.BLOCKS);
    UI.boardMirror(s, legalCellSet(), settings.boardMirror || !webglOk);
    if (renderer) {
      renderer.setState(s, { events: events || [] });
      updateTargetHighlights();
    }
  }

  function updateTargetHighlights() {
    if (!renderer || !round.state) return;
    const cells = [];
    legalCellSet().forEach(key => {
      const [x, y] = key.split(',').map(Number);
      const h = round.removeMode ? round.state.grid[y][x].length
        : (round.state.grid[y][x].length);
      cells.push({ x, y, h: round.removeMode ? h - 1 : h });
    });
    renderer.highlightTargets(cells, round.selectedBlock);
  }

  // ---------- command execution ----------
  function execute(fields) {
    if (!round.session || round.phase !== 'active') return;
    const res = Session.execute(round.session, fields, roundElapsed());
    if (!res.ok) {
      if (!res.duplicate) {
        Audio.play('invalid');
        haptic(30);
        UI.message(invalidText(res.reason));
      }
      return res;
    }
    if (res.duplicate) return res;
    round.state = res.state;
    processEvents(res.events);
    refreshUI(res.events);
    checkLesson(res.events);
    if (round.state.terminal) endRound();
    autosaveRound();
    return res;
  }

  function roundElapsed() {
    if (!round.startedAt) return 0;
    return performance.now() - round.startedAt;
  }

  function invalidText(reason) {
    return {
      'game-ended': 'The round is over.',
      'bad-cell': 'That spot is outside the plot.',
      'block-not-allowed': 'That block is not available here.',
      'no-resource': 'None left — gather more first.',
      'column-full': 'That column is already full.',
      'needs-support': 'Needs a solid block beneath it.',
      'topper-blocks-stacking': 'Nothing stacks on a topper.',
      'rock-is-immovable': 'Rock is immovable terrain.',
      'nothing-to-remove': 'Nothing to remove there.',
      'remove-disabled': 'The remove tool is disabled in this ruleset.'
    }[reason] || 'Not allowed.';
  }

  function processEvents(events) {
    events.forEach(e => {
      switch (e.type) {
        case 'gather': {
          Audio.play('gather');
          haptic(15);
          const gains = Object.entries(e.gains).map(([t, n]) => n + ' ' + Content.BLOCKS[t].label).join(', ');
          UI.message('Gathered ' + gains);
          break;
        }
        case 'place':
          Audio.play('place-' + e.block);
          haptic(20);
          if (e.h >= 5) unlock('tower-5');
          progress.stats.placed++;
          unlock('first-place');
          break;
        case 'remove': Audio.play('remove'); haptic(20); break;
        case 'goal': {
          Audio.play('goal');
          haptic([20, 40, 20]);
          const g = e.goal;
          UI.message('Goal complete: ' + goalLabel(g) + '!');
          UI.announce('Goal complete: ' + goalLabel(g));
          break;
        }
        case 'wave': Audio.play('wave'); UI.message('Wave ' + e.wave + ' — new goals!'); break;
        case 'goals-new': break;
        case 'win': Audio.play('win'); break;
        case 'lose': Audio.play('lose'); break;
      }
    });
  }

  function haptic(pattern) {
    if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  // ---------- round lifecycle ----------
  function startRound(cfg, mode, levelIndex) {
    round.session = Session.createSession(cfg);
    round.state = round.session.state;
    round.mode = mode;
    round.levelIndex = levelIndex == null ? -1 : levelIndex;
    round.lesson = null; round.lessonEvents = {};
    round.selectedBlock = cfg.blocks[0];
    round.removeMode = false;
    round.pendingCell = null;
    round.focusTargets = []; round.focusIndex = -1;
    round.startedAt = performance.now();
    round.pausedAt = 0;
    round.phase = 'active';
    Audio.setAvRng(RNG.derive(cfg.seed, RNG.STREAM_AV));
    if (renderer) {
      renderer.setPalette(themeById(cfg.theme || settings.theme).palette,
        settings.highContrast || settings.colorPalette === 'high-visibility');
      renderer.skipAnimations();
    }
    startWeather(cfg.seed);
    UI.showScreen('game', true); // no DOM screen: HUD-only playfield
    if (cfg.intro) UI.message(cfg.intro, true);
    funnel('start-' + mode);
    refreshUI();
    UI.announce('Round started. ' + (cfg.intro || cfg.name));
    saveRoundSnapshot();
  }

  function endRound() {
    round.phase = 'results';
    stopWeather();
    const s = round.state;
    progress.stats.rounds++;
    if (s.terminal.won) progress.stats.wins++;
    progress.stats.bestHeight = Math.max(progress.stats.bestHeight, Rules.maxBuiltHeight(s));
    progress.stats.playMs += s.elapsedMs;

    let achievements = [];
    const newly = (key) => {
      const a = Content.ACHIEVEMENTS.find(x => x.key === key);
      if (a) achievements.push(a);
    };
    const before = new Set(Object.keys(progress.achievements));

    if (s.terminal.won) {
      unlock('first-win');
      if (s.score.total >= 2500) unlock('score-2500');
    }
    if (round.mode === 'journey' && s.terminal.won) {
      const done = Object.keys(progress.journeyStars).length;
      if (done + 1 >= 20) unlock('journey-half');
      if (done + 1 >= Content.JOURNEY.length) unlock('journey-done');
      // stars: win + beat par + no removals
      const lvl = s.cfg;
      let stars = 1;
      if (lvl.par && s.moves <= lvl.par.moves) stars++;
      if (s.removed === 0) stars++;
      const prev = progress.journeyStars[lvl.id] || 0;
      progress.journeyStars[lvl.id] = Math.max(prev, stars);
      progress.journeyBest[lvl.id] = Math.max(progress.journeyBest[lvl.id] || 0, s.score.total);
    }
    if (round.mode === 'daily' && s.terminal.won) {
      progress.dailiesDone[s.cfg.date] = Math.max(progress.dailiesDone[s.cfg.date] || 0, s.score.total);
      if (Object.keys(progress.dailiesDone).length >= 7) unlock('daily-7');
    }
    if (round.mode === 'challenge' && s.terminal.won) {
      progress.challengeBest[s.cfg.id] = Math.max(progress.challengeBest[s.cfg.id] || 0, s.score.total);
      if (Content.CHALLENGES.every(c => progress.challengeBest[c.id] > 0)) unlock('challenger');
    }
    if (round.mode === 'score') {
      progress.endlessBest = Math.max(progress.endlessBest, s.score.total);
      progress.stats.waves = Math.max(progress.stats.waves, round.state.wave);
    }
    if (progress.stats.placed >= 500) unlock('blocks-500');
    persist();
    Object.keys(progress.achievements).filter(k => !before.has(k)).forEach(k => {
      const a = Content.ACHIEVEMENTS.find(x => x.key === k);
      if (a) achievements.push(a);
      deliverAchievement(k);
    });

    funnel('round-end-' + (s.terminal.won ? 'win' : 'lose'));
    clearRoundSnapshot();
    showResults(achievements);
    submitScore();
  }

  function unlock(key) {
    if (!progress.achievements[key]) {
      progress.achievements[key] = Date.now();
      Audio.play('star');
      UI.announce('Achievement unlocked');
    }
  }
  function deliverAchievement(key) {
    if (!hosted) return;
    fetch('/api/v1/achievement', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, player: playerName })
    }).catch(() => {});
  }

  function showResults(achievements) {
    const s = round.state;
    const won = s.terminal && s.terminal.won;
    const rows = [
      ['Blocks placed', '+' + s.score.place],
      ['Goals completed', '+' + s.score.goal],
      ['Settlement bonus', '+' + s.score.win],
      ['Stock remaining', '+' + s.score.stock],
      ['Under par', '+' + s.score.par],
      ['Removed blocks', '−' + s.score.removePenalty],
      ['Waves', s.wave > 1 ? String(s.wave - 1) : '—'],
      ['Total', String(s.score.total)]
    ];
    let stars = 0;
    if (round.mode === 'journey' && won) stars = progress.journeyStars[s.cfg.id] || 1;
    const hasNext = round.mode === 'journey' && won && round.levelIndex + 1 < Content.JOURNEY.length;
    UI.renderResults({
      title: won ? 'Settlement complete!' : 'Round over',
      headline: won
        ? s.cfg.name + ' — every goal met in ' + s.moves + ' moves.'
        : terminalReasonText(s.terminal ? s.terminal.reason : '') + ' — final score ' + s.score.total + '.',
      rows, stars, achievements,
      compare: s.terminal && s.terminal.won ? 'Time ' + fmtClock(s.elapsedMs) + ' · par ' +
        (s.cfg.par ? s.cfg.par.moves : '—') + ' moves' : '',
      hasNext, nextLabel: hasNext ? 'Next: ' + Content.JOURNEY[round.levelIndex + 1].name : 'Next'
    });
    UI.showScreen('results');
    UI.announce(won ? 'Stage complete. Score ' + s.score.total : 'Round over. Score ' + s.score.total);
  }

  function terminalReasonText(r) {
    return {
      'goals-met': 'All goals met', 'move-limit': 'Out of moves',
      'landlocked': 'The plot is sealed', 'resigned': 'Resigned'
    }[r] || r;
  }

  // ---------- score submission ----------
  function rankedBoard() {
    const s = round.state;
    if (!s) return null;
    if (round.mode === 'daily') return 'daily:' + s.cfg.date;
    if (round.mode === 'score') return 'global';
    if (round.mode === 'journey') return 'journey:' + s.cfg.id;
    if (round.mode === 'challenge') return 'challenge:' + s.cfg.id;
    return null; // practice/learn unranked
  }

  function submitScore() {
    const board = rankedBoard();
    if (!board) return;
    const envelope = Session.envelope(round.session);
    const entry = {
      board, name: playerName, score: envelope.score.total,
      durationMs: envelope.elapsedMs, invalid: envelope.invalid,
      sessionId, at: Date.now(), ruleset: envelope.contentId, seed: envelope.seed
    };
    // local copy always (offline-capable comparison)
    const boards = Store.loadBoards();
    boards.entries.push(entry);
    Store.saveBoards(boards);
    if (hosted) {
      fetch('/api/v1/score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board, name: playerName, sessionId, envelope, assists: currentAssists() })
      }).then(r => r.json()).then(j => {
        if (j && j.accepted) UI.toast('Score validated and posted');
        else if (j && j.error) UI.toast('Score rejected: ' + (j.reason || j.error));
      }).catch(() => {});
    }
  }

  function currentAssists() {
    return {
      undo: !!(round.state && round.state.cfg.mechanics && round.state.cfg.mechanics.undo !== false),
      hint: !!(round.state && round.state.cfg.mechanics && round.state.cfg.mechanics.hint !== false),
      confirmMoves: !!settings.confirmMoves
    };
  }

  // ---------- round snapshot (last safe local save) ----------
  const ROUND_KEY = 'blockstead.round.v1';
  function saveRoundSnapshot() {
    if (!round.session || round.state.terminal) return;
    try {
      localStorage.setItem(ROUND_KEY, JSON.stringify({
        cfg: round.session.cfg, commands: round.session.log, mode: round.mode,
        levelIndex: round.levelIndex, at: Date.now()
      }));
    } catch (e) {}
  }
  function autosaveRound() { saveRoundSnapshot(); }
  function clearRoundSnapshot() { try { localStorage.removeItem(ROUND_KEY); } catch (e) {} }
  function loadRoundSnapshot() {
    try {
      const raw = localStorage.getItem(ROUND_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw);
      if (!snap || !snap.cfg || !Array.isArray(snap.commands)) return null;
      return snap;
    } catch (e) { return null; }
  }
  function resumeSnapshot(snap) {
    const sess = Session.createSession(snap.cfg);
    for (const cmd of snap.commands) {
      if (Rules.validateCommandShape(cmd)) return false;
      const res = Rules.applyCommand(sess.state, cmd);
      if (!res.ok) return false;
      sess.state = res.state;
      sess.log.push(cmd);
    }
    round.session = sess;
    round.state = sess.state;
    round.mode = snap.mode || 'practice';
    round.levelIndex = snap.levelIndex == null ? -1 : snap.levelIndex;
    round.selectedBlock = sess.cfg.blocks[0];
    round.removeMode = false;
    round.startedAt = performance.now();
    round.phase = 'active';
    startWeather(sess.cfg.seed);
    UI.showScreen('game', true);
    refreshUI();
    UI.toast('Round restored');
    UI.announce('Round restored. ' + movesText(sess.state));
    return true;
  }

  // ---------- interaction ----------
  function onCellPicked(x, y) {
    if (round.phase !== 'active' || !round.state) return;
    Audio.play('select');
    if (settings.confirmMoves) {
      const key = x + ',' + y;
      if (round.pendingCell !== key) {
        round.pendingCell = key;
        UI.message('Tap again to confirm');
        showGhost(x, y);
        return;
      }
      round.pendingCell = null;
    }
    commitCell(x, y);
  }

  function commitCell(x, y) {
    if (round.removeMode) execute({ type: 'remove', x, y });
    else if (round.selectedBlock) execute({ type: 'place', x, y, block: round.selectedBlock });
    else UI.message('Pick a block from the tray first.');
  }

  function showGhost(x, y) {
    if (!renderer || !round.state) return;
    const st = round.state.grid[y][x];
    if (round.removeMode) {
      const valid = Rules.checkRemove(round.state, x, y) === null;
      renderer.ghost(x, y, Math.max(0, st.length - 1), valid);
      if (!valid) UI.message(invalidText(Rules.checkRemove(round.state, x, y)));
    } else if (round.selectedBlock) {
      const reason = Rules.checkPlace(round.state, x, y, round.selectedBlock);
      renderer.ghost(x, y, st.length, reason === null);
      if (reason) UI.message(invalidText(reason));
    }
  }

  function onCellHover(cell) {
    if (round.phase !== 'active' || !renderer || !round.state) return;
    if (!cell) { renderer.ghost(null); return; }
    showGhost(cell.x, cell.y);
  }

  function onMirrorCell(x, y) {
    if (round.phase !== 'active') return;
    if (settings.confirmMoves) { onCellPicked(x, y); return; }
    commitCell(x, y);
  }

  // keyboard target navigation among legal targets
  function rebuildFocusTargets() {
    round.focusTargets = Array.from(legalCellSet()).map(k => {
      const [x, y] = k.split(',').map(Number);
      return { x, y };
    });
    round.focusIndex = round.focusTargets.length ? 0 : -1;
  }
  function moveFocus(d) {
    if (!round.focusTargets.length) rebuildFocusTargets();
    if (!round.focusTargets.length) { UI.message('No legal targets right now — try Gather.'); return; }
    round.focusIndex = (round.focusIndex + d + round.focusTargets.length) % round.focusTargets.length;
    const t = round.focusTargets[round.focusIndex];
    showGhost(t.x, t.y);
    UI.announce('Target column ' + (t.x + 1) + ', ' + (t.y + 1));
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    const k = ev.key.toLowerCase();
    const inRound = round.phase === 'active';
    if (k === 'p' || (k === 'escape' && inRound)) { ev.preventDefault(); togglePause(); return; }
    if (k === 'escape') { UI.back(); return; }
    if (!inRound) return;
    if (k === 'arrowleft' || k === 'arrowup') { ev.preventDefault(); moveFocus(-1); }
    else if (k === 'arrowright' || k === 'arrowdown') { ev.preventDefault(); moveFocus(1); }
    else if (k === 'enter' || k === ' ') {
      ev.preventDefault();
      if (round.focusIndex >= 0 && round.focusTargets[round.focusIndex]) {
        const t = round.focusTargets[round.focusIndex];
        commitCell(t.x, t.y);
        rebuildFocusTargets();
      }
    }
    else if (k === 'g') execute({ type: 'gather' });
    else if (k === 'r') toggleRemove();
    else if (k === 'u') doUndo();
    else if (k === 'h') doHint();
    else if (k === 'c') { if (renderer) renderer.resetCamera(); }
    else if (k === 's') { if (renderer) renderer.skipAnimations(); UI.message('Animations skipped'); }
    else if (k >= '1' && k <= '5') {
      const i = +k - 1;
      const blocks = round.state.cfg.blocks;
      if (blocks[i]) selectBlock(blocks[i]);
    }
  });

  // basic gamepad: dpad navigate, A confirm, B cancel, start pause
  let padPrev = {};
  setInterval(() => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    if (!gp || round.phase !== 'active') { padPrev = {}; return; }
    const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    const edge = (name, v) => { const was = padPrev[name]; padPrev[name] = v; return v && !was; };
    if (edge('a', pressed(0))) {
      if (round.focusIndex >= 0) {
        const t = round.focusTargets[round.focusIndex];
        commitCell(t.x, t.y); rebuildFocusTargets();
      }
    }
    if (edge('b', pressed(1))) { round.removeMode = false; refreshUI(); }
    if (edge('x', pressed(2))) execute({ type: 'gather' });
    if (edge('y', pressed(3))) doUndo();
    if (edge('start', pressed(9))) togglePause();
    if (edge('l', pressed(14))) moveFocus(-1);
    if (edge('r', pressed(15))) moveFocus(1);
  }, 120);

  // ---------- actions ----------
  function selectBlock(b) {
    round.selectedBlock = b;
    round.removeMode = false;
    Audio.play('select');
    rebuildFocusTargets();
    refreshUI();
    UI.announce(Content.BLOCKS[b].label + ' selected');
  }
  function toggleRemove() {
    if (round.state.cfg.mechanics && round.state.cfg.mechanics.remove === false) {
      UI.message(invalidText('remove-disabled')); Audio.play('invalid'); return;
    }
    round.removeMode = !round.removeMode;
    Audio.play(round.removeMode ? 'select' : 'deselect');
    rebuildFocusTargets();
    refreshUI();
    UI.announce(round.removeMode ? 'Remove tool active' : 'Remove tool off');
  }
  function doUndo() {
    if (!round.session) return;
    if (round.phase !== 'active') return;
    if (!Session.canUndo(round.session)) {
      UI.message(round.state.cfg.mechanics.undo === false ? 'Undo is disabled in this ruleset.' : 'Nothing to undo.');
      Audio.play('invalid');
      return;
    }
    Session.undo(round.session);
    round.state = round.session.state;
    Audio.play('undo');
    round.lessonEvents.undo = (round.lessonEvents.undo || 0) + 1;
    checkLesson([{ type: 'undo' }]);
    rebuildFocusTargets();
    refreshUI();
    saveRoundSnapshot();
  }
  function doHint() {
    if (!round.state || round.phase !== 'active') return;
    if (round.state.cfg.mechanics && round.state.cfg.mechanics.hint === false) {
      UI.message('Hints are disabled in this ruleset.'); Audio.play('invalid'); return;
    }
    const h = Rules.hint(round.state);
    Audio.play('hint');
    if (!h) { UI.message('No hint available.'); return; }
    if (h.type === 'gather') UI.message('Hint: gather resources — you need ' + (h.why || 'supplies').replace('need-', '') + '.');
    else {
      UI.message('Hint: place ' + Content.BLOCKS[h.block].label + ' on column ' + (h.x + 1) + ', ' + (h.y + 1) + '.');
      selectBlock(h.block);
      if (renderer) showGhost(h.x, h.y);
    }
  }

  // ---------- pause / lifecycle ----------
  function togglePause() {
    if (round.phase === 'active') pauseRound();
    else if (round.phase === 'paused') resumeRound();
  }
  function pauseRound() {
    if (round.phase !== 'active') return;
    round.phase = 'paused';
    round.pausedAt = performance.now();
    Audio.suspend();
    saveRoundSnapshot();
    UI.showScreen('pause');
    refreshUI();
  }
  function resumeRound() {
    if (round.phase !== 'paused') return;
    round.phase = 'active';
    // shift the clock baseline so paused time never counts
    round.startedAt = performance.now() - round.state.elapsedMs;
    Audio.resume();
    if (UI.currentScreen() === 'pause') UI.back();
    refreshUI();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (round.phase === 'active') pauseRound();
      if (renderer) renderer.setRunning(false);
      Audio.suspend();
    } else {
      if (renderer) renderer.setRunning(true);
      Audio.resume();
    }
  });

  // ---------- lessons ----------
  function startLesson(id) {
    const lesson = Content.tutorialLessons().find(l => l.id === id);
    if (!lesson) return;
    startRound(lesson.cfg, 'learn', -1);
    round.lesson = lesson;
    UI.lessonBanner(lesson, '0/' + lesson.goal.count);
    UI.message('');
    funnel('tutorial-' + id);
  }
  function checkLesson(events) {
    const l = round.lesson;
    if (!l) return;
    events.forEach(e => {
      if (e.type === l.goal.event) round.lessonEvents[e.type] = (round.lessonEvents[e.type] || 0) + 1;
      if (e.type === 'win' && l.goal.event !== 'win') { /* stage win still counts */ }
    });
    const n = round.lessonEvents[l.goal.event] || 0;
    UI.lessonBanner(l, Math.min(n, l.goal.count) + '/' + l.goal.count);
    if (n >= l.goal.count || (l.goal.event === 'win' && round.state.terminal && round.state.terminal.won)) {
      progress.tutorialDone[l.id] = true;
      persist();
      funnel('tutorial-done-' + l.id);
      UI.lessonBanner(null);
      UI.toast('Lesson complete: ' + l.title);
      UI.announce('Lesson complete: ' + l.title);
      round.lesson = null;
      if (!round.state.terminal) {
        // keep playing or leave; lessons end cleanly here
        leaveRound(true);
        UI.showScreen('learn', true);
      }
    }
  }

  // ---------- screens / navigation ----------
  function leaveRound(silent) {
    stopWeather();
    if (round.session && !round.state.terminal && !silent) {
      // resign is a real, recorded terminal transition
      Session.execute(round.session, { type: 'resign' }, 0);
    }
    if (silent || !round.session) clearRoundSnapshot(); else saveRoundSnapshot();
    round.phase = 'title';
    round.session = null; round.state = null; round.lesson = null;
    UI.lessonBanner(null);
    UI.setHud({ visible: false, modeName: '', score: 0 });
    UI.boardMirror(null, null, false);
  }

  function showTitle() {
    round.phase = 'title';
    UI.showScreen('title', true);
    const snap = loadRoundSnapshot();
    const playBtn = document.getElementById('btn-play');
    playBtn.textContent = snap ? 'Resume round' : 'Play';
    updateJourneyMini();
  }

  function updateJourneyMini() {
    const done = Object.keys(progress.journeyStars).length;
    UI.setJourneyMini(done + '/' + Content.JOURNEY.length);
  }

  function updateDailyCountdown() {
    const now = nowMs();
    const next = Math.ceil(now / 86400000) * 86400000;
    const left = Math.max(0, next - now);
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
    const date = Content.utcDateString(now);
    const done = progress.dailiesDone[date];
    UI.setDailyCountdown((done ? '✓ ' + done + ' · ' : '') + 'new in ' + h + 'h ' + m + 'm');
  }

  function showModes() {
    UI.renderModes([
      { id: 'learn', name: 'Learn', desc: 'Interactive lessons — one rule at a time.', meta: '6 short lessons · unranked', cta: 'Start learning' },
      { id: 'journey', name: 'Journey', desc: '40 authored stages across the valley.', meta: Object.keys(progress.journeyStars).length + '/40 stages · ranked per stage' },
      { id: 'daily', name: 'Daily challenge', desc: 'One shared seed for everyone, per UTC day.', meta: 'Ranked · validated by replay' },
      { id: 'practice', name: 'Practice', desc: 'Relaxed play with undo and hints.', meta: '3 difficulties · unranked' },
      { id: 'challenge', name: 'Challenges', desc: 'Constrained goals: move limits, locked tools, rough plots.', meta: '6 challenges · ranked per challenge' },
      { id: 'score', name: 'Score chase', desc: 'Endless waves of goals until the plot seals.', meta: 'Global board · validated' }
    ]);
    UI.showScreen('modes');
  }

  let pendingMode = null;
  function selectMode(id) {
    pendingMode = id;
    if (id === 'learn') { showLessons(); return; }
    if (id === 'journey') { showJourney(); return; }
    if (id === 'daily') {
      const date = Content.utcDateString(nowMs());
      const cfg = Content.dailyConfig(date);
      showSetup(cfg, 'daily', [
        'Shared seed for ' + date, 'Expected 5–10 minutes',
        cfg.moveLimit ? 'Move limit: ' + cfg.moveLimit : 'No move limit',
        'Undo and hints allowed'
      ], true);
      return;
    }
    if (id === 'practice') {
      const p = Content.PRACTICE.find(x => x.id === round.practiceId) || Content.PRACTICE[0];
      showSetup(p, 'practice', [
        'Difficulty: ' + p.name, 'Restart and undo allowed', 'No effect on ratings'
      ], false, Content.PRACTICE.map(x => ({
        label: x.name, value: x.id, active: x.id === p.id
      })));
      return;
    }
    if (id === 'challenge') {
      const next = Content.CHALLENGES.find(c => !progress.challengeBest[c.id]) || Content.CHALLENGES[0];
      showSetup(next, 'challenge', challengeFacts(next), true,
        Content.CHALLENGES.map(c => ({
          label: c.name + (progress.challengeBest[c.id] ? ' ✓' : ''), value: c.id,
          active: c.id === next.id
        })));
      return;
    }
    if (id === 'score') {
      showSetup(Content.SCORE_CHASE, 'score', [
        'Endless: goals regenerate in harder waves',
        'No undo, no hints — every block counts',
        'Best: ' + progress.endlessBest
      ], true);
      return;
    }
  }

  function challengeFacts(c) {
    const f = [];
    if (c.moveLimit) f.push('Move limit: ' + c.moveLimit);
    if (c.mechanics.remove === false) f.push('Remove tool locked');
    if (c.mechanics.undo === false) f.push('No undo');
    if (c.mechanics.hint === false) f.push('No hints');
    if (c.rocks) f.push(c.rocks + ' boulders on the plot');
    f.push('Expected 5–10 minutes');
    return f;
  }

  let setupCtx = null;
  function showSetup(cfg, mode, facts, ranked, options) {
    setupCtx = { cfg, mode };
    UI.renderSetup({
      name: cfg.name, intro: cfg.intro, facts, ranked, options
    });
    UI.showScreen('setup');
  }

  function startSetupRound() {
    if (!setupCtx) return;
    startRound(setupCtx.cfg, setupCtx.mode, -1);
  }

  function showJourney() {
    UI.renderJourney(Content.JOURNEY, progress);
    UI.showScreen('journey');
  }

  function showLessons() {
    UI.renderLessons(Content.tutorialLessons(), progress);
    UI.showScreen('learn');
  }

  function showProfile() {
    const stars = Object.values(progress.journeyStars).reduce((a, b) => a + b, 0);
    const themes = Content.THEMES.map(t => ({
      id: t.id, name: t.name, unlockStars: t.unlockStars,
      unlocked: stars >= t.unlockStars, active: settings.theme === t.id
    }));
    UI.renderProfile({
      name: playerName,
      subtitle: hosted ? 'Connected to host — scores are validated.' : 'Local guest profile — fully playable offline.',
      stats: [
        'Rounds played: ' + progress.stats.rounds,
        'Settlements completed: ' + progress.stats.wins,
        'Blocks placed: ' + progress.stats.placed,
        'Tallest column: ' + progress.stats.bestHeight,
        'Journey stars: ' + stars,
        'Best endless score: ' + progress.endlessBest,
        'Dailies completed: ' + Object.keys(progress.dailiesDone).length,
        'Time played: ' + fmtClock(progress.stats.playMs)
      ],
      achievements: Content.ACHIEVEMENTS.map(a => ({
        key: a.key, name: a.name, desc: a.desc, unlocked: !!progress.achievements[a.key]
      })),
      themes
    });
    UI.showScreen('profile');
  }

  let lbActive = 'global';
  async function showLeaderboard() {
    const date = Content.utcDateString(nowMs());
    const boards = [
      { id: 'global', label: 'Endless (global)' },
      { id: 'daily:' + date, label: 'Today’s daily' }
    ];
    let entries = [], note = '';
    if (hosted) {
      try {
        const r = await fetch('/api/v1/leaderboard?board=' + encodeURIComponent(lbActive));
        const j = await r.json();
        entries = j.entries || [];
        note = 'Validated by server replay. Ties: fewer invalid actions, then faster time.';
      } catch (e) { hosted = false; }
    }
    if (!hosted) {
      entries = Store.sortEntries(Store.loadBoards().entries.filter(e => e.board === lbActive));
      note = 'Offline — showing locally recorded scores (casual board).';
    }
    UI.renderLeaderboard({
      boards, active: lbActive, note,
      entries: entries.map(e => ({
        name: e.name, score: e.score, durationMs: e.durationMs,
        when: e.at ? new Date(e.at).toLocaleDateString() : '—'
      }))
    });
    UI.showScreen('leaderboard');
  }

  function showHelp() {
    UI.renderHelp([
      { title: 'Goal', text: 'Gather resources and place blocks to complete every build goal. Rocks are immovable terrain; build around or on them.', keys: null },
      { title: 'Gather', text: 'Collect timber, stone and more from the valley. Gathering spends a move when the ruleset has a move limit.', keys: 'G or the ⛏ button' },
      { title: 'Place', text: 'Select a block in the tray, then choose a glowing tile. Blocks stack into columns.', keys: '1–5 select · click/tap or Enter places' },
      { title: 'Glass needs support', text: 'Glass, lamps and plants cannot rest on bare soil — they need a solid block beneath them.' },
      { title: 'Toppers', text: 'Lamps and plants crown a stack: nothing can be built above them.' },
      { title: 'Remove & undo', text: 'Remove takes back the top block of a column for a small point penalty. Undo rewinds your last action where the ruleset allows it.', keys: 'R remove tool · U undo' },
      { title: 'Hints', text: 'Hints use the same legal-action rules as play — they never cheat.', keys: 'H' },
      { title: 'Camera', text: 'Drag to orbit, scroll to zoom.', keys: 'C resets the view' },
      { title: 'Pause', text: 'Backgrounding the tab pauses solo play automatically.', keys: 'P or Esc' }
    ]);
    UI.showScreen('help');
  }

  // ---------- settings ----------
  UI.defineSettings([
    { title: 'Audio', items: [
      { key: 'music', label: 'Music', type: 'range' },
      { key: 'effects', label: 'Effects', type: 'range' },
      { key: 'ambience', label: 'Ambience', type: 'range' },
      { key: 'voice', label: 'Voice cues', type: 'range' },
      { key: 'muted', label: 'Mute all', type: 'checkbox' },
      { key: 'captions', label: 'Captions for sounds', type: 'checkbox' }
    ] },
    { title: 'Graphics', items: [
      { key: 'graphicsTier', label: 'Quality tier', type: 'select', options: [
        { value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }
      ] },
      { key: 'reducedMotion', label: 'Reduced motion', type: 'checkbox' },
      { key: 'highContrast', label: 'High contrast', type: 'checkbox' },
      { key: 'colorPalette', label: 'Color palette', type: 'select', options: [
        { value: 'standard', label: 'Standard' }, { value: 'high-visibility', label: 'High visibility' }
      ] }
    ] },
    { title: 'Controls & access', items: [
      { key: 'largeText', label: 'Larger text', type: 'checkbox' },
      { key: 'leftHanded', label: 'Left-handed layout', type: 'checkbox' },
      { key: 'haptics', label: 'Haptics (vibration)', type: 'checkbox' },
      { key: 'boardMirror', label: 'Always show text board', type: 'checkbox' },
      { key: 'confirmMoves', label: 'Confirm moves (timing assistance)', type: 'checkbox' }
    ] }
  ]);

  function onSettingChange(key, value) {
    settings[key] = value;
    persist();
    applyVisualSettings();
    funnel('settings-' + key);
    if (key === 'boardMirror' || key === 'graphicsTier') refreshUI();
  }

  // ---------- audio unlock on first gesture ----------
  function unlockAudio() {
    if (!Audio.isStarted()) Audio.start();
    Audio.applySettings(settings);
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // ---------- wire UI hooks ----------
  UI.init({
    onPlay: () => {
      const snap = loadRoundSnapshot();
      if (snap && resumeSnapshot(snap)) return;
      showModes();
    },
    onDaily: () => selectMode('daily'),
    onJourney: () => showJourney(),
    onProfile: () => showProfile(),
    onHelp: () => showHelp(),
    onSettings: () => { UI.renderSettings(settings); UI.showScreen('settings'); },
    onLeaderboard: () => showLeaderboard(),
    onPause: () => togglePause(),
    onResume: () => resumeRound(),
    onRestart: () => {
      if (!round.session) return;
      const cfg = round.session.cfg, mode = round.mode, idx = round.levelIndex;
      funnel('retry');
      UI.back();
      startRound(cfg, mode, idx);
      if (round.lesson) round.lesson = null;
    },
    onLeave: () => { leaveRound(false); showTitle(); },
    onResultsNext: () => {
      if (round.mode === 'journey' && round.levelIndex + 1 < Content.JOURNEY.length) {
        const next = round.levelIndex + 1;
        UI.showScreen('results', true); UI.back();
        startRound(Content.JOURNEY[next], 'journey', next);
      }
    },
    onResultsRetry: () => {
      const cfg = round.session.cfg, mode = round.mode, idx = round.levelIndex;
      funnel('retry');
      UI.showScreen('results', true); UI.back();
      startRound(cfg, mode, idx);
    },
    onResultsMenu: () => { leaveRound(true); showTitle(); },
    onGather: () => execute({ type: 'gather' }),
    onRemoveToggle: () => toggleRemove(),
    onUndo: () => doUndo(),
    onHint: () => doHint(),
    onSkip: () => { if (renderer) renderer.skipAnimations(); UI.message('Animations skipped'); },
    onCamera: () => { if (renderer) renderer.resetCamera(); },
    onStartRound: () => startSetupRound(),
    onLessonQuit: () => { round.lesson = null; UI.lessonBanner(null); leaveRound(true); showLessons(); },
    onWebglContinue: () => {
      UI.webglFallback(false);
      settings.boardMirror = true;
      persist();
      refreshUI();
    },
    onPaletteSelect: (b) => selectBlock(b),
    onMirrorCell: (x, y) => onMirrorCell(x, y),
    onModeSelect: (id) => selectMode(id),
    onJourneyLevel: (i) => startRound(Content.JOURNEY[i], 'journey', i),
    onLessonSelect: (id) => startLesson(id),
    onSettingChange: (key, v) => onSettingChange(key, v),
    onSetupOption: (value) => {
      if (!setupCtx) return;
      if (setupCtx.mode === 'practice') {
        round.practiceId = value;
        selectMode('practice');
      } else if (setupCtx.mode === 'challenge') {
        const c = Content.CHALLENGES.find(x => x.id === value);
        if (c) showSetup(c, 'challenge', challengeFacts(c), true,
          Content.CHALLENGES.map(x => ({
            label: x.name + (progress.challengeBest[x.id] ? ' ✓' : ''), value: x.id,
            active: x.id === c.id
          })));
      }
    },
    onThemeSelect: (id) => {
      settings.theme = id;
      progress.cosmetics.theme = id;
      persist();
      applyVisualSettings();
      showProfile();
      UI.toast('Theme applied: ' + themeById(id).name);
    },
    onWipe: () => {
      doc = Store.fresh();
      settings = doc.settings; progress = doc.progress;
      persist();
      clearRoundSnapshot();
      applyVisualSettings();
      showTitle();
      UI.toast('Local progress erased');
    },
    onBoardSelect: (id) => { lbActive = id; showLeaderboard(); }
  });

  // ---------- elapsed ticker ----------
  setInterval(() => {
    if (round.phase === 'active' && round.state) {
      document.getElementById('hud-timer').textContent = fmtClock(roundElapsed());
    }
    if (round.phase === 'title') updateDailyCountdown();
  }, 1000);

  // ---------- boot ----------
  async function boot() {
    document.getElementById('app').setAttribute('data-screen', 'boot');
    bootRenderer();
    await syncTime();
    applyVisualSettings();
    showTitle();
    updateDailyCountdown();
    round.phase = 'title';
    funnel('boot');
  }

  boot();
})();
