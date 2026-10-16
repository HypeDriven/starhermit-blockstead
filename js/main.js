/* Blockstead — bootstrap + game controller (ES module).
 * Owns the state machine:
 *   boot → title → profile-ready → mode-select → preparing →
 *   tutorial/countdown → active ↔ paused → resolving → results → progression
 * Only this module issues validated commands into the session layer.
 */
import { createRenderer } from './render.js';
import { mountGraphicsPanel, accountStrings, pickLocale } from './gfx-panel.js';

(function () {
  'use strict';

  const Rules = window.BSRules;
  const Content = window.BSContent;
  const Store = window.BSStore;
  const Session = window.BSSession;
  const UI = window.BSUI;
  const Audio = window.BSAudio;
  const RNG = window.BSRNG;
  const P = window.BSPlatform; // StarHermit adapter (js/platform.js over starhermit-sdk.js)
  const I18N = window.BLI18n;  // js/i18n.js — one language source (sh-language.js)
  const t = I18N.t;
  // Account lines follow the game language (Settings → Language).
  const acct = () => accountStrings(I18N.lang || pickLocale(navigator.languages || [navigator.language]));

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
  let playerName = 'Guest-' + sessionId.slice(1, 5); // offline fallback label (stored with local scores)
  const guestLabel = () => t('guest', { id: sessionId.slice(1, 5) });

  // ---------- platform: StarHermit identity + authenticated /api ----------
  // Launch token, renewal, nicknames, cloud save, settings KV and bindings
  // live in BSPlatform; nothing is requested without a token.
  let signedOutNotice = false;
  const profileFor = P.profileFor;
  function displayName() { return (P.profile && P.profile.displayName) || guestLabel(); }

  function accountLine() {
    const A = acct();
    if (!P.hosted) return signedOutNotice ? A.signedOut : A.offline;
    const name = P.profile ? P.profile.displayName : '…';
    const sync = P.sync === 'synced' ? A.synced : P.sync === 'saving' ? A.saving : A.syncOff;
    return A.playingAs.replace('{name}', name) + ' · ' + sync;
  }
  function refreshAccount() {
    const line = document.getElementById('account-line');
    if (line) line.textContent = accountLine();
    const si = document.getElementById('btn-sign-in'), inv = document.getElementById('btn-invite');
    si.textContent = acct().signIn; si.hidden = !P.canSignIn();
    inv.textContent = acct().invite; inv.hidden = !P.hosted;
  }
  const showToast = (text) => UI.toast(text);
  async function copyInvite() {
    const link = P.inviteLink();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); showToast(acct().inviteCopied); }
    catch (e) { showToast(acct().inviteFailed + ' ' + link); }
  }

  // Keyboard actions by KeyboardEvent.code (control.* in starhermit.txt);
  // a signed-in player's StarHermit overrides replace these at boot.
  const KEY_DEFAULTS = {
    pause: ['KeyP'], back: ['Escape'], prev: ['ArrowLeft', 'ArrowUp'], next: ['ArrowRight', 'ArrowDown'],
    place: ['Enter', 'Space', 'NumpadEnter'], gather: ['KeyG'], remove: ['KeyR'], undo: ['KeyU'], hint: ['KeyH'],
    camera: ['KeyC'], topDown: ['KeyT'], skip: ['KeyS'],
    block1: ['Digit1', 'Numpad1'], block2: ['Digit2', 'Numpad2'], block3: ['Digit3', 'Numpad3'],
    block4: ['Digit4', 'Numpad4'], block5: ['Digit5', 'Numpad5'],
  };
  let keyBindings = JSON.parse(JSON.stringify(KEY_DEFAULTS));
  function actionForCode(code) {
    for (const a in keyBindings) if (keyBindings[a].includes(code)) return a;
    return null;
  }
  function keyName(action) {
    const names = { Escape: t('key.Esc'), Space: t('key.Space'), Enter: t('key.Enter'), ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
    return (keyBindings[action] || []).map(c => names[c] || c.replace(/^Key/, '').replace(/^Digit/, '')
      .replace(/^NumpadEnter$/, t('key.Num') + ' ' + t('key.Enter')).replace(/^Numpad/, t('key.Num') + ' ')).join('/');
  }

  // ---------- platform time (signed in only; standalone uses the local clock) ----------
  let timeOffset = 0;
  function nowMs() { return Date.now() + timeOffset; }
  async function syncTime() {
    if (!P.hosted) return; // no own-server request without a launch token
    try {
      const t0 = Date.now();
      const r = await fetch('/api/v1/time', { cache: 'no-store', headers: { 'Authorization': 'Bearer ' + P.token } });
      const t1 = Date.now();
      if (!r.ok) return;
      const j = await r.json();
      // Platform contract is { serverTime }; the local dev server answers { now }.
      const serverNow = Number(j && (j.serverTime != null ? j.serverTime : j.now));
      if (!Number.isFinite(serverNow) || serverNow <= 0) return;
      timeOffset = serverNow - Math.round((t0 + t1) / 2);
    } catch (e) { /* keep the local clock */ }
  }

  // ---------- renderer ----------
  let renderer = null, webglOk = true;
  function bootRenderer() {
    try {
      renderer = createRenderer({
        host: document.getElementById('scene-host'),
        graphics: settings.gfx,
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
      renderer.setGraphics(settings.gfx);
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
      else if (w === 'cloud') Audio.play('weather-cloud');
    };
    weatherTimer = setInterval(tick, 40000);
  }
  function stopWeather() { if (weatherTimer) clearInterval(weatherTimer); weatherTimer = null; }

  // ---------- helpers ----------
  function goalLabel(g) {
    if (g.kind === 'count') return t('goal.count', { block: I18N.blockLabel(g.type) });
    if (g.kind === 'height') return t('goal.height');
    return t('goal.columns', { h: g.h });
  }
  function goalsView(state) {
    return state.cfg.goals.map((g, i) => {
      const p = Rules.goalProgress(state, g);
      return { label: goalLabel(g), have: p.have, need: p.need, done: state.goalsDone[i] || p.done };
    });
  }
  function movesText(state) {
    return state.cfg.moveLimit ? t('moves.limit', { n: state.moves, max: state.cfg.moveLimit }) : t('moves', { n: state.moves });
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
      modeName: I18N.cfgName(s.cfg),
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
    if (!round.state) return res; // a completed lesson already left the round
    if (round.state.terminal) endRound();
    autosaveRound();
    return res;
  }

  function roundElapsed() {
    if (!round.startedAt) return 0;
    return performance.now() - round.startedAt;
  }

  function invalidText(reason) {
    return t('inv.' + reason, null, t('inv.default'));
  }

  function processEvents(events) {
    events.forEach(e => {
      switch (e.type) {
        case 'gather': {
          Audio.play('gather');
          haptic(15);
          progress.stats.gathered++;
          const gains = Object.entries(e.gains).map(([b, n]) => n + ' ' + I18N.blockLabel(b)).join(', ');
          UI.message(t('msg.gathered', { list: gains }));
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
          UI.message(t('msg.goal', { g: goalLabel(g) }));
          UI.announce(t('an.goal', { g: goalLabel(g) }));
          break;
        }
        case 'wave': Audio.play('wave'); UI.message(t('msg.wave', { n: e.wave })); break;
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
    Audio.play('round-start');
    round.introShown = !!cfg.intro; // sticky intro line, re-rendered on a language change
    round.introText = cfg.intro ? I18N.cfgIntro(cfg) : null;
    if (cfg.intro) UI.message(round.introText, true);
    funnel('start-' + mode);
    refreshUI();
    UI.announce(t('an.roundStart', { x: I18N.cfgIntro(cfg) || I18N.cfgName(cfg) }));
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
    const before = new Set(Object.keys(progress.achievements));

    if (s.terminal.won) {
      unlock('first-win');
      if (s.score.total >= 2500) unlock('score-2500');
    }
    if (round.mode === 'journey' && s.terminal.won) {
      // stars: win + beat par + no removals
      const lvl = s.cfg;
      let stars = 1;
      if (lvl.par && s.moves <= lvl.par.moves) stars++;
      if (s.removed === 0) stars++;
      const prev = progress.journeyStars[lvl.id] || 0;
      progress.journeyStars[lvl.id] = Math.max(prev, stars);
      progress.journeyBest[lvl.id] = Math.max(progress.journeyBest[lvl.id] || 0, s.score.total);
      const done = Object.keys(progress.journeyStars).length;
      if (done >= 20) unlock('journey-half');
      if (done >= Content.JOURNEY.length) unlock('journey-done');
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
    });

    funnel('round-end-' + (s.terminal.won ? 'win' : 'lose'));
    clearRoundSnapshot();
    showResults(achievements);
    submitScore();
  }

  function unlock(key) {
    if (!progress.achievements[key]) {
      progress.achievements[key] = Date.now();
      persist(); // mid-round unlocks survive a closed tab
      Audio.play('star');
      UI.announce(t('an.achievement'));
    }
  }
  let lastResults = null; // re-rendered on a language change
  function showResults(achievements, rerender) {
    lastResults = achievements;
    const s = round.state;
    const won = s.terminal && s.terminal.won;
    const rows = [
      [t('r.placed'), '+' + s.score.place],
      [t('r.goals'), '+' + s.score.goal],
      [t('r.bonus'), '+' + s.score.win],
      [t('r.stock'), '+' + s.score.stock],
      [t('r.par'), '+' + s.score.par],
      [t('r.removed'), '−' + s.score.removePenalty],
      [t('r.waves'), s.wave > 1 ? String(s.wave - 1) : '—'],
      [t('r.total'), String(s.score.total)]
    ];
    let stars = 0;
    if (round.mode === 'journey' && won) stars = progress.journeyStars[s.cfg.id] || 1;
    const hasNext = round.mode === 'journey' && won && round.levelIndex + 1 < Content.JOURNEY.length;
    UI.renderResults({
      title: won ? t('r.won') : t('results.over'),
      headline: won
        ? t('r.wonHead', { name: I18N.cfgName(s.cfg), n: s.moves })
        : t('r.lostHead', { reason: terminalReasonText(s.terminal ? s.terminal.reason : ''), n: s.score.total }),
      rows, stars, achievements: achievements.map(I18N.achievementView),
      compare: s.terminal && s.terminal.won ? t('r.compare', { t: fmtClock(s.elapsedMs), p: s.cfg.par ? s.cfg.par.moves : '—' }) : '',
      hasNext, nextLabel: hasNext ? t('r.nextName', { name: I18N.cfgName(Content.JOURNEY[round.levelIndex + 1]) }) : t('btn.next')
    });
    if (rerender) return;
    const art = document.getElementById('results-art');
    if (art) { art.hidden = false; art.src = won ? 'assets/results-win.webp' : 'assets/results-lose.webp'; }
    UI.showScreen('results');
    UI.announce(won ? t('an.stageDone', { n: s.score.total }) : t('an.roundOver', { n: s.score.total }));
  }

  function terminalReasonText(r) {
    return t('term.' + r, null, r);
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

  // Hosted play only: post a ranked round's total to the platform
  // high-score board and show the player's rank on the results overlay.
  function postToLeaderboard(total) {
    const line = document.getElementById('results-lb');
    if (!line) return;
    const seq = ++lbSeq;
    lbResult = null;
    if (!P || !P.hosted) { line.hidden = true; return; }
    line.hidden = false;
    lbResult = { pending: true };
    renderLbLine();
    P.submitScore(total).then(r => {
      if (seq !== lbSeq) return;
      lbResult = r;
      renderLbLine();
    });
  }
  // Results-line text from the stored outcome: a language change re-renders it, never reposts.
  let lbSeq = 0, lbResult = null;
  function renderLbLine() {
    const line = document.getElementById('results-lb');
    const r = lbResult;
    if (!line || !r) return;
    line.textContent = r.pending ? t('lb.posting') : !r.posted ? t('lb.notPosted')
      : r.rank ? t('lb.rank', { rank: r.rank }) : t('lb.posted');
  }

  function submitScore() {
    const board = rankedBoard();
    const lbLine = document.getElementById('results-lb');
    if (lbLine) lbLine.hidden = true;
    if (!board) return;
    postToLeaderboard(round.state.score.total);
    const envelope = Session.envelope(round.session);
    const entry = {
      board, name: playerName, player: P.userId || undefined, score: envelope.score.total,
      durationMs: envelope.elapsedMs, invalid: envelope.invalid,
      sessionId, at: Date.now(), ruleset: envelope.contentId, seed: envelope.seed
    };
    // boards are kept on this device
    const boards = Store.loadBoards();
    boards.entries.push(entry);
    Store.saveBoards(boards);
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
    round.lesson = null; round.lessonEvents = {};
    round.selectedBlock = sess.cfg.blocks[0];
    round.removeMode = false;
    round.pendingCell = null;
    round.focusTargets = []; round.focusIndex = -1;
    round.startedAt = performance.now();
    round.phase = 'active';
    Audio.setAvRng(RNG.derive(sess.cfg.seed, RNG.STREAM_AV));
    if (renderer) {
      renderer.setPalette(themeById(sess.cfg.theme || settings.theme).palette,
        settings.highContrast || settings.colorPalette === 'high-visibility');
      renderer.skipAnimations();
    }
    startWeather(sess.cfg.seed);
    UI.showScreen('game', true);
    Audio.play('round-start');
    refreshUI();
    round.introShown = false;
    UI.toast(t('toast.restored'));
    UI.announce(t('an.restored', { moves: movesText(sess.state) }));
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
        UI.message(t('msg.confirm'));
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
    else UI.message(t('msg.pickBlock'));
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
    if (!round.focusTargets.length) { UI.message(t('msg.noTargets')); return; }
    round.focusIndex = (round.focusIndex + d + round.focusTargets.length) % round.focusTargets.length;
    const tg = round.focusTargets[round.focusIndex];
    showGhost(tg.x, tg.y);
    UI.announce(t('an.target', { x: tg.x + 1, y: tg.y + 1 }));
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    const k = actionForCode(ev.code);
    const inRound = round.phase === 'active';
    if (k === 'pause' || (k === 'back' && inRound)) { ev.preventDefault(); togglePause(); return; }
    if (k === 'back') { UI.back(); return; }
    if (!inRound) return;
    if (k === 'prev') { ev.preventDefault(); moveFocus(-1); }
    else if (k === 'next') { ev.preventDefault(); moveFocus(1); }
    else if (k === 'place') {
      ev.preventDefault();
      if (round.focusIndex >= 0 && round.focusTargets[round.focusIndex]) {
        const tg = round.focusTargets[round.focusIndex];
        commitCell(tg.x, tg.y);
        rebuildFocusTargets();
      }
    }
    else if (k === 'gather') execute({ type: 'gather' });
    else if (k === 'remove') toggleRemove();
    else if (k === 'undo') doUndo();
    else if (k === 'hint') doHint();
    else if (k === 'camera') { if (renderer) renderer.resetCamera(); }
    else if (k === 'topDown') { if (renderer) renderer.topDownCamera(); }
    else if (k === 'skip') { if (renderer) renderer.skipAnimations(); UI.message(t('msg.skipped')); }
    else if (k && /^block[1-5]$/.test(k)) {
      const i = +k.slice(5) - 1;
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
        const tg = round.focusTargets[round.focusIndex];
        commitCell(tg.x, tg.y); rebuildFocusTargets();
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
    UI.announce(t('an.selected', { b: I18N.blockLabel(b) }));
  }
  function toggleRemove() {
    if (round.state.cfg.mechanics && round.state.cfg.mechanics.remove === false) {
      UI.message(invalidText('remove-disabled')); Audio.play('invalid'); return;
    }
    round.removeMode = !round.removeMode;
    Audio.play(round.removeMode ? 'select' : 'deselect');
    rebuildFocusTargets();
    refreshUI();
    UI.announce(round.removeMode ? t('an.removeOn') : t('an.removeOff'));
  }
  function doUndo() {
    if (!round.session) return;
    if (round.phase !== 'active') return;
    if (!Session.canUndo(round.session)) {
      UI.message(round.state.cfg.mechanics.undo === false ? t('msg.undoOff') : t('msg.noUndo'));
      Audio.play('invalid');
      return;
    }
    Session.undo(round.session);
    round.state = round.session.state;
    Audio.play('undo');
    checkLesson([{ type: 'undo' }]);
    if (!round.state) return; // the undo lesson just completed and left the round
    rebuildFocusTargets();
    refreshUI();
    saveRoundSnapshot();
  }
  function doHint() {
    if (!round.state || round.phase !== 'active') return;
    if (round.state.cfg.mechanics && round.state.cfg.mechanics.hint === false) {
      UI.message(t('msg.hintOff')); Audio.play('invalid'); return;
    }
    const h = Rules.hint(round.state);
    Audio.play('hint');
    if (!h) { UI.message(t('msg.noHint')); return; }
    if (h.type === 'gather') {
      const need = /^need-/.test(h.why || '') ? h.why.slice(5) : null;
      UI.message(t('hint.gather', { what: need ? I18N.blockLabel(need) : t('hint.supplies') }));
    } else {
      UI.message(t('hint.place', { b: I18N.blockLabel(h.block), x: h.x + 1, y: h.y + 1 }));
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
    Audio.play('pause');
    // let the pause cue finish before the context sleeps; a quick resume cancels it
    setTimeout(() => { if (round.phase === 'paused') Audio.suspend(); }, 350);
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
    Audio.play('resume');
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
    UI.lessonBanner(I18N.lessonView(lesson), '0/' + lesson.goal.count);
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
    UI.lessonBanner(I18N.lessonView(l), Math.min(n, l.goal.count) + '/' + l.goal.count);
    if (n >= l.goal.count || (l.goal.event === 'win' && round.state.terminal && round.state.terminal.won)) {
      progress.tutorialDone[l.id] = true;
      persist();
      funnel('tutorial-done-' + l.id);
      UI.lessonBanner(null);
      Audio.play('lesson-complete');
      UI.toast(t('toast.lesson', { t: I18N.lessonView(l).title }));
      UI.announce(t('toast.lesson', { t: I18N.lessonView(l).title }));
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
    // a resigned or finished round must not come back as "Resume round"
    clearRoundSnapshot();
    round.phase = 'title';
    round.session = null; round.state = null; round.lesson = null;
    UI.lessonBanner(null);
    UI.setHud({ visible: false, modeName: '', score: 0 });
    UI.boardMirror(null, null, false);
  }

  function showTitle() {
    round.phase = 'title';
    UI.showScreen('title', true);
    if (renderer) renderer.showShowcase(); // slowly turning sample homestead behind the menu
    const snap = loadRoundSnapshot();
    const playBtn = document.getElementById('btn-play');
    playBtn.textContent = snap ? t('btn.resumeRound') : t('btn.play');
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
    UI.setDailyCountdown((done ? t('daily.done', { n: done }) : '') + t('daily.newIn', { h, m }));
  }

  function showModes(rerender) {
    const m = (id, extra) => Object.assign({ id, name: t('mode.' + id), desc: t('mode.' + id + '.d'), meta: t('mode.' + id + '.m', { n: Object.keys(progress.journeyStars).length }) }, extra || {});
    UI.renderModes([
      m('learn', { cta: t('mode.learn.cta') }), m('journey'), m('daily'), m('practice'), m('challenge'), m('score')
    ]);
    if (!rerender) UI.showScreen('modes');
  }

  let pendingMode = null;
  function selectMode(id, rerender) {
    pendingMode = id;
    if (id === 'learn') { showLessons(); return; }
    if (id === 'journey') { showJourney(); return; }
    if (id === 'daily') {
      const date = Content.utcDateString(nowMs());
      const cfg = Content.dailyConfig(date);
      showSetup(cfg, 'daily', [
        t('f.dailySeed', { date }), t('f.expected'),
        cfg.moveLimit ? t('f.moveLimit', { n: cfg.moveLimit }) : t('f.noLimit'),
        t('f.undoHints')
      ], true, null, rerender);
      return;
    }
    if (id === 'practice') {
      const p = Content.PRACTICE.find(x => x.id === round.practiceId) || Content.PRACTICE[0];
      showSetup(p, 'practice', [
        t('f.difficulty', { d: I18N.cfgName(p) }), t('f.restartUndo'), t('f.noRating')
      ], false, Content.PRACTICE.map(x => ({
        label: I18N.cfgName(x), value: x.id, active: x.id === p.id
      })), rerender);
      return;
    }
    if (id === 'challenge') {
      const next = Content.CHALLENGES.find(c => !progress.challengeBest[c.id]) || Content.CHALLENGES[0];
      showChallengeSetup(next);
      return;
    }
    if (id === 'score') {
      showSetup(Content.SCORE_CHASE, 'score', [
        t('f.endless'), t('f.noAssist'), t('f.best', { n: progress.endlessBest })
      ], true, null, rerender);
      return;
    }
  }

  function challengeFacts(c) {
    const f = [];
    if (c.moveLimit) f.push(t('f.moveLimit', { n: c.moveLimit }));
    if (c.mechanics.remove === false) f.push(t('f.removeLocked'));
    if (c.mechanics.undo === false) f.push(t('f.noUndo'));
    if (c.mechanics.hint === false) f.push(t('f.noHints'));
    if (c.rocks) f.push(t('f.rocks', { n: c.rocks }));
    f.push(t('f.expected'));
    return f;
  }
  function showChallengeSetup(c, rerender) {
    showSetup(c, 'challenge', challengeFacts(c), true,
      Content.CHALLENGES.map(x => ({
        label: I18N.cfgName(x) + (progress.challengeBest[x.id] ? ' ✓' : ''), value: x.id,
        active: x.id === c.id
      })), rerender);
  }

  let setupCtx = null;
  function showSetup(cfg, mode, facts, ranked, options, rerender) {
    setupCtx = { cfg, mode };
    UI.renderSetup({
      name: I18N.cfgName(cfg), intro: I18N.cfgIntro(cfg), facts, ranked, options
    });
    if (!rerender) UI.showScreen('setup');
  }

  function startSetupRound() {
    if (!setupCtx) return;
    startRound(setupCtx.cfg, setupCtx.mode, -1);
  }

  function showJourney(rerender) {
    UI.renderJourney(Content.JOURNEY, progress);
    if (!rerender) UI.showScreen('journey');
  }

  function showLessons(rerender) {
    UI.renderLessons(Content.tutorialLessons().map(I18N.lessonView), progress);
    if (!rerender) UI.showScreen('learn');
  }

  function showProfile(rerender) {
    const stars = Object.values(progress.journeyStars).reduce((a, b) => a + b, 0);
    const themes = Content.THEMES.map(t => ({
      id: t.id, name: I18N.themeName(t), unlockStars: t.unlockStars,
      unlocked: stars >= t.unlockStars, active: settings.theme === t.id
    }));
    UI.renderProfile({
      name: displayName(),
      subtitle: P.userId ? t('prof.signedIn', { name: displayName() }) : t('prof.guest'),
      stats: [
        t('st.rounds', { n: progress.stats.rounds }),
        t('st.wins', { n: progress.stats.wins }),
        t('st.placed', { n: progress.stats.placed }),
        t('st.height', { n: progress.stats.bestHeight }),
        t('st.stars', { n: stars }),
        t('st.endless', { n: progress.endlessBest }),
        t('st.dailies', { n: Object.keys(progress.dailiesDone).length }),
        t('st.time', { t: fmtClock(progress.stats.playMs) })
      ],
      achievements: Content.ACHIEVEMENTS.map(a => Object.assign(I18N.achievementView(a), { unlocked: !!progress.achievements[a.key] })),
      themes
    });
    if (!rerender) UI.showScreen('profile');
  }

  let lbActive = 'global';
  async function showLeaderboard(rerender) {
    const date = Content.utcDateString(nowMs());
    const boards = [
      { id: 'global', label: t('lb.global') },
      { id: 'daily:' + date, label: t('lb.today') }
    ];
    let entries = Store.sortEntries(Store.loadBoards().entries.filter(e => e.board === lbActive));
    const note = t('lb.note');
    // Resolve account ids to profile nicknames; mark the signed-in row.
    entries = await Promise.all(entries.map(async e => {
      if (!e.player) return e;
      const name = await profileFor(e.player);
      return Object.assign({}, e, {
        name: e.player === P.userId ? t('lb.you', { name }) : name
      });
    }));
    UI.renderLeaderboard({
      boards, active: lbActive, note,
      entries: entries.map(e => ({
        name: e.name, score: e.score, durationMs: e.durationMs,
        when: e.at ? new Date(e.at).toLocaleDateString(I18N.lang) : '—'
      }))
    });
    if (!rerender) UI.showScreen('leaderboard');
  }

  function showHelp(rerender) {
    const card = (id, keys) => ({ title: t('h.' + id), text: t('h.' + id + '.b'), keys: keys || null });
    UI.renderHelp([
      card('goal'),
      card('gather', t('h.gather.k', { k: keyName('gather') })),
      card('place', t('h.place.k', { a: keyName('block1'), b: keyName('block5'), p: keyName('place') })),
      card('support'),
      card('toppers'),
      card('remove', t('h.remove.k', { r: keyName('remove'), u: keyName('undo') })),
      card('hints', keyName('hint')),
      card('camera', t('h.camera.k', { c: keyName('camera'), t: keyName('topDown') })),
      card('pause', t('h.pause.k', { p: keyName('pause'), b: keyName('back') }))
    ]);
    if (!rerender) UI.showScreen('help');
  }

  // ---------- settings ----------
  UI.defineSettings([
    { i18n: 'set.audio', items: [
      { key: 'music', i18n: 'set.music', type: 'range' },
      { key: 'effects', i18n: 'set.effects', type: 'range' },
      { key: 'ambience', i18n: 'set.ambience', type: 'range' },
      { key: 'voice', i18n: 'set.voice', type: 'range' },
      { key: 'muted', i18n: 'set.muted', type: 'checkbox' },
      { key: 'captions', i18n: 'set.captions', type: 'checkbox' }
    ] },
    { i18n: 'set.graphics', id: 'settings-graphics', items: [
      { type: 'custom', render: (box) => gfxPanel = mountGraphicsPanel(box, {
        get: () => settings.gfx,
        set: (next) => {
          settings.gfx = next;
          persist();
          if (renderer) renderer.setGraphics(settings.gfx);
          funnel('settings-gfx');
        },
        info: () => renderer ? renderer.graphicsInfo() : null
      }) },
      { key: 'reducedMotion', i18n: 'set.reducedMotion', type: 'checkbox' },
      { key: 'highContrast', i18n: 'set.highContrast', type: 'checkbox' },
      { key: 'colorPalette', i18n: 'set.colorPalette', type: 'select', options: [
        { value: 'standard', i18n: 'pal.standard' }, { value: 'high-visibility', i18n: 'pal.high-visibility' }
      ] }
    ] },
    { i18n: 'set.controls', items: [
      { key: 'largeText', i18n: 'set.largeText', type: 'checkbox' },
      { key: 'leftHanded', i18n: 'set.leftHanded', type: 'checkbox' },
      { key: 'haptics', i18n: 'set.haptics', type: 'checkbox' },
      { key: 'boardMirror', i18n: 'set.boardMirror', type: 'checkbox' },
      { key: 'confirmMoves', i18n: 'set.confirmMoves', type: 'checkbox' }
    ] }
  ]);
  let gfxPanel = null; // { sync, relabel } of the mounted Graphics panel

  function onSettingChange(key, value) {
    settings[key] = value;
    persist();
    applyVisualSettings();
    funnel('settings-' + key);
    if (key === 'boardMirror') refreshUI();
  }

  // ---------- audio unlock on first gesture ----------
  function unlockAudio() {
    if (!Audio.isStarted()) Audio.start();
    Audio.applySettings(settings);
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // menu acknowledgment: every DOM-screen button ticks (HUD tools have their own cues)
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('#screens .btn, #lesson-quit, #webgl-continue') : null;
    if (t && !t.disabled) Audio.play('ui');
  });

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
    onSkip: () => { if (renderer) renderer.skipAnimations(); UI.message(t('msg.skipped')); },
    onCamera: () => { if (renderer) renderer.resetCamera(); },
    onTopDown: () => { if (renderer) renderer.topDownCamera(); },
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
        if (c) showChallengeSetup(c);
      }
    },
    onThemeSelect: (id) => {
      settings.theme = id;
      progress.cosmetics.theme = id;
      persist();
      applyVisualSettings();
      showProfile();
      UI.toast(t('toast.theme', { name: I18N.themeName(themeById(id)) }));
    },
    onWipe: () => {
      doc = Store.fresh();
      settings = doc.settings; progress = doc.progress;
      persist();
      clearRoundSnapshot();
      applyVisualSettings();
      showTitle();
      UI.toast(t('toast.erased'));
    },
    onBoardSelect: (id) => { lbActive = id; showLeaderboard(); }
  });

  // ---------- language (Settings → Language / StarHermit preferred language) ----------
  // Re-render every visible string in place: the open screen and any screen under an
  // overlay, the HUD, goals, tray, lesson banner and account lines. Round state, focus,
  // the open Settings panel and the posted leaderboard result are untouched.
  function onLanguageChange() {
    if (round.phase === 'boot') return;
    refreshAccount();
    updateJourneyMini();
    updateDailyCountdown();
    const snap = loadRoundSnapshot();
    document.getElementById('btn-play').textContent = snap ? t('btn.resumeRound') : t('btn.play');
    if (gfxPanel && gfxPanel.relabel && document.contains(document.getElementById('gfx-preset'))) gfxPanel.relabel();
    const stack = UI.stack ? UI.stack() : [UI.currentScreen()];
    const open = (name) => stack.indexOf(name) >= 0;
    if (open('modes')) showModes(true);
    if (open('setup') && setupCtx) {
      if (setupCtx.mode === 'challenge') showChallengeSetup(setupCtx.cfg, true);
      else selectMode(setupCtx.mode, true);
    }
    if (open('journey')) showJourney(true);
    if (open('learn')) showLessons(true);
    if (open('profile')) showProfile(true);
    if (open('leaderboard')) showLeaderboard(true);
    if (open('help')) showHelp(true);
    if (open('results') && lastResults && round.state) { showResults(lastResults, true); renderLbLine(); }
    if (round.state && (round.phase === 'active' || round.phase === 'paused')) {
      refreshUI();
      if (round.lesson) {
        const l = round.lesson, n = round.lessonEvents[l.goal.event] || 0;
        UI.lessonBanner(I18N.lessonView(l), Math.min(n, l.goal.count) + '/' + l.goal.count);
      }
      const msg = document.getElementById('hud-message');
      if (round.introText && msg && msg.textContent === round.introText) {
        round.introText = I18N.cfgIntro(round.state.cfg);
        msg.textContent = round.introText;
      }
    }
  }
  document.addEventListener('bl-language', onLanguageChange);

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
    document.getElementById('btn-sign-in').addEventListener('click', () => P.signIn());
    document.getElementById('btn-invite').addEventListener('click', copyInvite);
    refreshAccount();
    await syncTime();
    applyVisualSettings();
    showTitle();
    updateDailyCountdown();
    round.phase = 'title';
    funnel('boot');
    // StarHermit: remote save wins over the local copy and platform settings
    // over saved preferences; localStorage stays the offline cache.
    const remoteRaw = await P.init({
      onProfile: refreshAccount,
      onSync: refreshAccount,
      // Another device saved first: merge its copy into this one (better records win,
      // this device's settings and the round in progress stay) and save the result.
      onConflict: (raw) => {
        const remote = raw ? Store.loadRaw(raw) : null;
        if (!remote) return;
        doc = Store.mergeDocs(remote, { v: doc.v, settings, progress });
        settings = doc.settings; progress = doc.progress;
        progress.stats.funnel = progress.stats.funnel || {};
        persist();
        if (round.phase === 'title') { updateJourneyMini(); updateDailyCountdown(); }
      },
      onAuth: (a) => { if (!a.signedIn) signedOutNotice = true; refreshAccount(); }
    }).catch(() => null);
    refreshAccount();
    if (!P.hosted) return;
    const remote = remoteRaw ? Store.loadRaw(remoteRaw) : null;
    if (remote) { doc = remote; settings = doc.settings; progress = doc.progress; }
    const ps = P.platformSettings;
    if (ps) Object.keys(Store.DEFAULT_SETTINGS).forEach(k => { if (k in ps) settings[k] = ps[k]; });
    progress.stats.funnel = progress.stats.funnel || {};
    persist();
    applyVisualSettings();
    if (round.phase === 'title') showTitle();
    keyBindings = await P.loadBindings(KEY_DEFAULTS);
  }

  boot();
})();
