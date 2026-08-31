/* Blockstead — DOM shell: responsive screens, HUD, settings, help,
 * profile, leaderboards, lessons, board mirror, toasts, announcements.
 * UI state is separate from simulation state; this module never touches
 * rules directly. Browser global: BSUI. All controls are semantic HTML.
 */
(function (root) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var hooks = {};
  var screenStack = ['title'];
  var settingsSchema = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- screens ----------
  function currentScreen() { return screenStack[screenStack.length - 1]; }

  function showScreen(name, replace) {
    if (replace) screenStack[screenStack.length - 1] = name;
    else if (currentScreen() !== name) screenStack.push(name);
    var app = $('app');
    app.setAttribute('data-screen', name);
    document.querySelectorAll('#screens .screen').forEach(function (s) {
      var overlay = s.classList.contains('overlay');
      var active = s.getAttribute('data-name') === name;
      var underlay = overlay && screenStack.indexOf(s.getAttribute('data-name')) >= 0;
      s.classList.toggle('active', active);
      s.classList.toggle('underlay', !active && underlay);
    });
    // focus the first heading or primary button of the shown screen
    var sec = document.querySelector('#screens .screen[data-name="' + name + '"]');
    if (sec) {
      var target = sec.querySelector('.btn.primary') || sec.querySelector('h1,h2,button');
      if (target) setTimeout(function () {
        if (!target.hasAttribute('tabindex') && !/BUTTON/.test(target.tagName)) {
          target.setAttribute('tabindex', '-1');
        }
        target.focus({ preventScroll: true });
      }, 30);
    }
    announce(screenLabel(name));
  }

  function back() {
    if (screenStack.length > 1) screenStack.pop();
    showScreen(currentScreen(), true);
  }

  function screenLabel(name) {
    return {
      title: 'Title screen', modes: 'Mode selection', setup: 'Round setup',
      journey: 'Journey stages', pause: 'Paused', results: 'Round results',
      settings: 'Settings', help: 'How to play', profile: 'Profile',
      leaderboard: 'Scores', learn: 'Lessons'
    }[name] || name;
  }

  // ---------- announcements / toasts / captions ----------
  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2400);
  }
  function announce(text) { $('sr-live').textContent = text; }
  var captionTimer = null;
  function caption(text) {
    var c = $('caption');
    c.textContent = text;
    c.classList.remove('hidden');
    c.setAttribute('aria-hidden', 'false');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { c.classList.add('hidden'); }, 1600);
  }
  var msgTimer = null;
  function message(text, sticky) {
    var m = $('hud-message');
    m.textContent = text || '';
    m.classList.toggle('hidden', !text);
    clearTimeout(msgTimer);
    if (text && !sticky) msgTimer = setTimeout(function () {
      m.classList.add('hidden');
    }, 2600);
    if (text) announce(text);
  }

  // ---------- HUD ----------
  function setHud(view) {
    $('hud-mode-name').textContent = view.modeName;
    $('hud-timer').textContent = view.timerText || '';
    $('hud-score').textContent = '★ ' + view.score;
    $('hud-moves').textContent = view.movesText || '';
    ['hud-top', 'hud-goals', 'hud-palette', 'hud-actions'].forEach(function (id) {
      $(id).classList.toggle('hidden', !view.visible);
    });
    $('btn-undo').disabled = !view.canUndo;
    $('btn-hint').disabled = !view.canHint;
    $('btn-remove').setAttribute('aria-pressed', view.removeMode ? 'true' : 'false');
    $('btn-remove').disabled = view.removeAllowed === false;
  }

  function setGoals(goals) {
    var ul = $('goals-list');
    ul.textContent = '';
    goals.forEach(function (g) {
      var li = el('li', 'goal-item' + (g.done ? ' goal-done' : ''));
      li.textContent = (g.done ? '✓ ' : '○ ') + g.label + ' — ' + g.have + '/' + g.need;
      ul.appendChild(li);
    });
  }

  function setPalette(blocks, inv, selected, contentBlocks) {
    var wrap = $('palette-blocks');
    wrap.textContent = '';
    blocks.forEach(function (b) {
      var meta = contentBlocks[b] || { label: b, icon: '?' };
      var btn = el('button', 'btn icon palette-btn' + (selected === b ? ' selected' : ''));
      btn.setAttribute('aria-pressed', selected === b ? 'true' : 'false');
      btn.setAttribute('aria-label', meta.label + ', ' + (inv[b] || 0) + ' in stock');
      btn.appendChild(el('span', 'palette-icon', meta.icon));
      btn.appendChild(el('span', 'btn-sub', meta.label + ' ×' + (inv[b] || 0)));
      btn.addEventListener('click', function () { hooks.onPaletteSelect(b); });
      wrap.appendChild(btn);
    });
  }

  // ---------- board mirror (DOM equivalent of the 3D plot) ----------
  function boardMirror(state, legalSet, visible) {
    var host = $('board-mirror');
    host.classList.toggle('hidden', !visible || !state);
    if (!visible || !state) return;
    var plot = $('mirror-plot');
    plot.textContent = '';
    plot.style.gridTemplateColumns = 'repeat(' + state.cfg.plot.cols + ', 1fr)';
    for (var y = 0; y < state.cfg.plot.rows; y++) {
      for (var x = 0; x < state.cfg.plot.cols; x++) {
        (function (x, y) {
          var st = state.grid[y][x];
          var top = st.length ? st[st.length - 1] : null;
          var b = el('button', 'mirror-cell');
          var key = x + ',' + y;
          var label = 'Column ' + (x + 1) + ', ' + (y + 1) + ': ' +
            (st.length ? st.join(', ') : 'empty') +
            (legalSet && legalSet.has(key) ? ', legal target' : '');
          b.setAttribute('aria-label', label);
          b.textContent = top ? ({ wood: '🪵', stone: '🪨', glass: '🧊', plant: '🌿', lamp: '🏮', rock: '⛰' })[top] || '▪' : '·';
          if (st.length > 1) b.setAttribute('data-h', st.length);
          if (legalSet && legalSet.has(key)) b.classList.add('legal');
          b.addEventListener('click', function () { hooks.onMirrorCell(x, y); });
          plot.appendChild(b);
        })(x, y);
      }
    }
  }

  // ---------- mode list / setup ----------
  function renderModes(modes) {
    var list = $('mode-list');
    list.textContent = '';
    modes.forEach(function (m) {
      var card = el('div', 'mode-item');
      card.appendChild(el('h3', null, m.name));
      card.appendChild(el('p', 'mini', m.desc));
      card.appendChild(el('p', 'mini', m.meta));
      var btn = el('button', 'btn primary', m.cta || 'Play');
      btn.addEventListener('click', function () { hooks.onModeSelect(m.id); });
      card.appendChild(btn);
      list.appendChild(card);
    });
  }

  function renderSetup(info) {
    var body = $('setup-body');
    body.textContent = '';
    body.appendChild(el('h3', null, info.name));
    body.appendChild(el('p', null, info.intro || ''));
    var ul = el('ul', 'setup-facts');
    info.facts.forEach(function (f) { ul.appendChild(el('li', null, f)); });
    body.appendChild(ul);
    body.appendChild(el('p', 'mini', info.ranked ?
      'This result is ranked and validated by replay.' : 'Unranked — relaxed play, no rating effect.'));
    if (info.options) {
      info.options.forEach(function (opt) {
        var btn = el('button', 'btn option-btn', opt.label);
        btn.setAttribute('aria-pressed', opt.active ? 'true' : 'false');
        if (opt.active) btn.classList.add('selected');
        btn.addEventListener('click', function () { hooks.onSetupOption(opt.value); });
        body.appendChild(btn);
      });
    }
  }

  // ---------- journey ----------
  function renderJourney(levels, progress) {
    $('journey-stars-total').textContent =
      'Stars: ' + levels.reduce(function (n, l) { return n + (progress.journeyStars[l.id] || 0); }, 0) +
      ' / ' + levels.length * 3;
    var grid = $('journey-grid');
    grid.textContent = '';
    levels.forEach(function (l, i) {
      var stars = progress.journeyStars[l.id] || 0;
      var unlocked = i === 0 || (progress.journeyStars[levels[i - 1].id] || 0) > 0;
      var btn = el('button', 'level-cell' + (unlocked ? '' : ' locked') + (l.mastery ? ' mastery' : ''));
      btn.disabled = !unlocked;
      btn.setAttribute('aria-label', 'Stage ' + (i + 1) + ': ' + l.name +
        (unlocked ? ', ' + stars + ' of 3 stars' : ', locked'));
      btn.appendChild(el('span', 'level-num', String(i + 1)));
      btn.appendChild(el('span', 'level-name', l.name));
      btn.appendChild(el('span', 'level-stars', unlocked ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '🔒'));
      if (unlocked) btn.addEventListener('click', function () { hooks.onJourneyLevel(i); });
      grid.appendChild(btn);
    });
  }

  // ---------- results ----------
  function renderResults(r) {
    $('results-h').textContent = r.title;
    $('results-headline').textContent = r.headline;
    var tbody = $('results-table').querySelector('tbody');
    tbody.textContent = '';
    r.rows.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', null, row[0]));
      var td = el('td', null, row[1]);
      td.style.textAlign = 'right';
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    $('results-stars').textContent = r.stars ? '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars) : '';
    var ach = $('results-achievements');
    ach.textContent = '';
    (r.achievements || []).forEach(function (a) {
      ach.appendChild(el('li', null, '🏅 ' + a.name + ' — ' + a.desc));
    });
    $('results-compare').textContent = r.compare || '';
    $('btn-results-next').textContent = r.nextLabel || 'Next';
    $('btn-results-next').disabled = !r.hasNext;
  }

  // ---------- settings ----------
  function defineSettings(schema) { settingsSchema = schema; }
  function renderSettings(settings) {
    var form = $('settings-form');
    form.textContent = '';
    settingsSchema.forEach(function (sec) {
      var fs = el('fieldset');
      fs.appendChild(el('legend', null, sec.title));
      sec.items.forEach(function (item) {
        var label = el('label');
        label.textContent = item.label + ' ';
        var input;
        if (item.type === 'range') {
          input = el('input');
          input.type = 'range'; input.min = 0; input.max = 1; input.step = 0.05;
          input.value = settings[item.key];
        } else if (item.type === 'select') {
          input = el('select');
          item.options.forEach(function (o) {
            var op = el('option', null, o.label);
            op.value = o.value;
            input.appendChild(op);
          });
          input.value = settings[item.key];
        } else {
          input = el('input');
          input.type = 'checkbox';
          input.checked = !!settings[item.key];
        }
        input.addEventListener('change', function () {
          var v = item.type === 'range' ? +input.value :
            item.type === 'select' ? input.value : input.checked;
          hooks.onSettingChange(item.key, v);
        });
        label.appendChild(input);
        fs.appendChild(label);
      });
      form.appendChild(fs);
    });
  }

  // ---------- help ----------
  function renderHelp(cards) {
    var body = $('help-body');
    body.textContent = '';
    cards.forEach(function (c) {
      var card = el('div', 'help-card');
      card.appendChild(el('h3', null, c.title));
      card.appendChild(el('p', null, c.text));
      if (c.keys) card.appendChild(el('p', 'mini', c.keys));
      body.appendChild(card);
    });
  }

  // ---------- profile ----------
  function renderProfile(p) {
    var body = $('profile-body');
    body.textContent = '';
    body.appendChild(el('h3', null, p.name));
    body.appendChild(el('p', 'mini', p.subtitle));
    var stats = el('ul');
    p.stats.forEach(function (s) { stats.appendChild(el('li', null, s)); });
    body.appendChild(stats);
    body.appendChild(el('h3', null, 'Achievements'));
    var ul = el('ul', 'achievements');
    p.achievements.forEach(function (a) {
      ul.appendChild(el('li', a.unlocked ? 'unlocked' : 'locked',
        (a.unlocked ? '🏅 ' : '▫ ') + a.name + ' — ' + a.desc));
    });
    body.appendChild(ul);
    body.appendChild(el('h3', null, 'Themes'));
    var tw = el('div', 'theme-row');
    p.themes.forEach(function (t) {
      var b = el('button', 'btn option-btn' + (t.active ? ' selected' : ''), t.name);
      b.disabled = !t.unlocked;
      b.setAttribute('aria-pressed', t.active ? 'true' : 'false');
      if (!t.unlocked) b.textContent += ' 🔒 (' + t.unlockStars + '★)';
      b.addEventListener('click', function () { hooks.onThemeSelect(t.id); });
      tw.appendChild(b);
    });
    body.appendChild(tw);
    var wipe = el('button', 'btn danger', 'Erase local progress');
    wipe.addEventListener('click', function () {
      if (root.confirm('Erase all local progress and settings?')) hooks.onWipe();
    });
    body.appendChild(el('p'));
    body.appendChild(wipe);
  }

  // ---------- leaderboards ----------
  function renderLeaderboard(data) {
    var body = $('lb-body');
    body.textContent = '';
    var tabs = el('div', 'lb-tabs');
    data.boards.forEach(function (b) {
      var btn = el('button', 'btn option-btn' + (b.id === data.active ? ' selected' : ''), b.label);
      btn.addEventListener('click', function () { hooks.onBoardSelect(b.id); });
      tabs.appendChild(btn);
    });
    body.appendChild(tabs);
    if (data.note) body.appendChild(el('p', 'mini', data.note));
    if (!data.entries.length) {
      body.appendChild(el('p', null, 'No scores yet — be the first.'));
      return;
    }
    var table = el('table');
    table.className = 'lb-table';
    var head = el('tr');
    ['#', 'Player', 'Score', 'Moves time', 'When'].forEach(function (h) {
      head.appendChild(el('th', null, h));
    });
    table.appendChild(head);
    data.entries.forEach(function (e, i) {
      var tr = el('tr');
      [String(i + 1), e.name, String(e.score), formatMs(e.durationMs), e.when].forEach(function (v) {
        tr.appendChild(el('td', null, v));
      });
      table.appendChild(tr);
    });
    body.appendChild(table);
  }

  function formatMs(ms) {
    if (!ms) return '—';
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ---------- lessons ----------
  function renderLessons(lessons, progress) {
    var list = $('lesson-list');
    list.textContent = '';
    lessons.forEach(function (l) {
      var done = !!progress.tutorialDone[l.id];
      var card = el('div', 'mode-item');
      card.appendChild(el('h3', null, (done ? '✓ ' : '') + l.title));
      card.appendChild(el('p', 'mini', l.text));
      var btn = el('button', 'btn primary', done ? 'Replay lesson' : 'Start lesson');
      btn.addEventListener('click', function () { hooks.onLessonSelect(l.id); });
      card.appendChild(btn);
      list.appendChild(card);
    });
  }

  function lessonBanner(lesson, progressText) {
    var b = $('lesson-banner');
    b.classList.toggle('hidden', !lesson);
    if (lesson) {
      $('lesson-title').textContent = lesson.title + (progressText ? ' — ' + progressText : '');
      $('lesson-text').textContent = lesson.text;
    }
  }

  function setDailyCountdown(text) { $('daily-countdown').textContent = text; }
  function setJourneyMini(text) { $('journey-progress-mini').textContent = text; }

  function webglFallback(show) { $('webgl-fallback').classList.toggle('hidden', !show); }

  // ---------- init ----------
  function init(h) {
    hooks = h;
    var bind = function (id, fn) { $(id).addEventListener('click', fn); };
    bind('btn-play', function () { hooks.onPlay(); });
    bind('btn-daily', function () { hooks.onDaily(); });
    bind('btn-journey', function () { hooks.onJourney(); });
    bind('btn-profile', function () { hooks.onProfile(); });
    bind('btn-help', function () { hooks.onHelp(); });
    bind('btn-settings', function () { hooks.onSettings(); });
    bind('btn-leaderboard', function () { hooks.onLeaderboard(); });
    bind('btn-pause', function () { hooks.onPause(); });
    bind('btn-resume', function () { hooks.onResume(); });
    bind('btn-restart', function () { hooks.onRestart(); });
    bind('btn-leave', function () { hooks.onLeave(); });
    bind('btn-pause-settings', function () { hooks.onSettings(); });
    bind('btn-pause-help', function () { hooks.onHelp(); });
    bind('btn-results-next', function () { hooks.onResultsNext(); });
    bind('btn-results-retry', function () { hooks.onResultsRetry(); });
    bind('btn-results-menu', function () { hooks.onResultsMenu(); });
    bind('btn-gather', function () { hooks.onGather(); });
    bind('btn-remove', function () { hooks.onRemoveToggle(); });
    bind('btn-undo', function () { hooks.onUndo(); });
    bind('btn-hint', function () { hooks.onHint(); });
    bind('btn-skip', function () { hooks.onSkip(); });
    bind('btn-camera', function () { hooks.onCamera(); });
    bind('btn-start-round', function () { hooks.onStartRound(); });
    bind('lesson-quit', function () { hooks.onLessonQuit(); });
    bind('webgl-continue', function () { hooks.onWebglContinue(); });
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', back);
    });
  }

  root.BSUI = {
    init: init,
    showScreen: showScreen, back: back, currentScreen: currentScreen,
    toast: toast, announce: announce, caption: caption, message: message,
    setHud: setHud, setGoals: setGoals, setPalette: setPalette, boardMirror: boardMirror,
    renderModes: renderModes, renderSetup: renderSetup, renderJourney: renderJourney,
    renderResults: renderResults, defineSettings: defineSettings, renderSettings: renderSettings,
    renderHelp: renderHelp, renderProfile: renderProfile, renderLeaderboard: renderLeaderboard,
    renderLessons: renderLessons, lessonBanner: lessonBanner,
    setDailyCountdown: setDailyCountdown, setJourneyMini: setJourneyMini,
    webglFallback: webglFallback
  };
})(typeof self !== 'undefined' ? self : this);
