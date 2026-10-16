/* Blockstead — persistence: versioned, checksummed local save document.
 * Never stores credentials or tokens. Browser global: window.BSStore.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSStore = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var SAVE_VERSION = 1;
  var KEY = 'blockstead.save.v1';
  var LB_KEY = 'blockstead.leaderboards.v1';

  var DEFAULT_SETTINGS = {
    music: 0.55, effects: 0.9, ambience: 0.5, voice: 0.8,
    muted: false, captions: false,
    // graphics quality (see js/gfx.js): preset auto|low|balanced|high|ultra,
    // render_scale 0.5–2, adaptive, show_fps, plus optional per-effect overrides
    gfx: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false },
    theme: 'meadow',
    reducedMotion: false,
    highContrast: false,
    colorPalette: 'standard',   // standard | high-visibility
    largeText: false,
    leftHanded: false,
    haptics: true,
    boardMirror: false,         // always-visible DOM board
    confirmMoves: false         // timing assistance: tap target again to confirm
  };

  function defaultProgress() {
    return {
      tutorialDone: {},        // lessonId -> true
      journeyStars: {},        // levelId -> 0..3
      journeyBest: {},         // levelId -> score
      challengeBest: {},       // challengeId -> score
      dailiesDone: {},         // dateStr -> score
      endlessBest: 0,
      achievements: {},        // key -> unlockedAtMs
      stats: { rounds: 0, wins: 0, placed: 0, gathered: 0, bestHeight: 0, waves: 0, playMs: 0 },
      cosmetics: { theme: 'meadow' }
    };
  }

  function checksum(str) { // FNV-1a, decimal string
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function migrate(doc) {
    // v1 is current; older shapes are upgraded field-by-field here.
    if (!doc || typeof doc !== 'object') return null;
    if (doc.v > SAVE_VERSION) return null; // future format: don't clobber
    doc.v = SAVE_VERSION;
    var old = doc.settings || {};
    doc.settings = Object.assign({}, DEFAULT_SETTINGS, old);
    // pre-gfx saves stored a single quality tier
    if (!old.gfx || typeof old.gfx !== 'object') {
      var tierMap = { low: 'low', medium: 'balanced', high: 'high' };
      doc.settings.gfx = Object.assign({}, DEFAULT_SETTINGS.gfx, { preset: tierMap[old.graphicsTier] || 'auto' });
    }
    delete doc.settings.graphicsTier;
    doc.progress = Object.assign(defaultProgress(), doc.progress || {});
    return doc;
  }

  function fresh() {
    var settings = Object.assign({}, DEFAULT_SETTINGS);
    settings.gfx = Object.assign({}, DEFAULT_SETTINGS.gfx);
    return { v: SAVE_VERSION, settings: settings, progress: defaultProgress() };
  }

  // Another device saved the cloud slot since this one loaded it: combine the
  // two documents so neither side's progress is lost. Records keep the better
  // value (stars, best scores, counters, latest daily), unlock maps are
  // unioned (earliest achievement time), and this device's settings win.
  function mergeDocs(remote, local) {
    var r = migrate(remote ? JSON.parse(JSON.stringify(remote)) : null);
    var l = migrate(local ? JSON.parse(JSON.stringify(local)) : null);
    if (!r) return l || fresh();
    if (!l) return r;
    var rp = r.progress, lp = l.progress, out = l;
    function better(a, b) {
      if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
      return a || b;
    }
    function mergeMap(a, b) {
      var m = {}, k;
      for (k in a) m[k] = a[k];
      for (k in b) m[k] = k in m ? better(m[k], b[k]) : b[k];
      return m;
    }
    ['tutorialDone', 'journeyStars', 'journeyBest', 'challengeBest', 'dailiesDone'].forEach(function (k) {
      out.progress[k] = mergeMap(rp[k] || {}, lp[k] || {});
    });
    var funnel = lp.stats && lp.stats.funnel;
    var rs = Object.assign({}, rp.stats || {}); delete rs.funnel;
    var ls = Object.assign({}, lp.stats || {}); delete ls.funnel;
    out.progress.stats = mergeMap(rs, ls);
    if (funnel) out.progress.stats.funnel = funnel; // local-only counters stay this device's
    out.progress.endlessBest = Math.max(rp.endlessBest || 0, lp.endlessBest || 0);
    var ach = {}, key;
    for (key in rp.achievements) ach[key] = rp.achievements[key];
    for (key in lp.achievements) ach[key] = ach[key] ? Math.min(ach[key], lp.achievements[key]) : lp.achievements[key];
    out.progress.achievements = ach;
    return out;
  }

  var memoryFallback = null; // used when localStorage is unavailable

  // Parses a wrapped {sum, payload} string into a migrated doc, or null.
  // Used for the local copy and the StarHermit cloud mirror alike.
  function loadRaw(raw) {
    if (raw == null) return null;
    try {
      var doc = JSON.parse(raw);
      if (!doc || doc.sum !== checksum(doc.payload)) return null; // corrupt
      return migrate(JSON.parse(doc.payload));
    } catch (e) { return null; }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (raw == null && memoryFallback) raw = memoryFallback;
    return loadRaw(raw) || fresh(); // corrupt → clean slate
  }

  function save(doc) {
    doc.v = SAVE_VERSION;
    var payload = JSON.stringify(doc);
    var wrapped = JSON.stringify({ sum: checksum(payload), payload: payload });
    memoryFallback = wrapped;
    try { localStorage.setItem(KEY, wrapped); } catch (e) { /* memory fallback keeps session */ }
    if (root && root.BSPlatform && typeof root.BSPlatform.onLocalSave === 'function')
      root.BSPlatform.onLocalSave(wrapped); // StarHermit cloud + settings mirror
  }

  // ---------- leaderboards (local; host adapter may sync) ----------
  function loadBoards() {
    try {
      var raw = localStorage.getItem(LB_KEY);
      var b = raw ? JSON.parse(raw) : null;
      return (b && Array.isArray(b.entries)) ? b : { entries: [] };
    } catch (e) { return { entries: [] }; }
  }
  function saveBoards(b) {
    try { localStorage.setItem(LB_KEY, JSON.stringify(b)); } catch (e) {}
  }

  // Ties: higher score, then fewer invalid actions, then lower elapsed,
  // then stable session id. Returns sorted copy.
  function sortEntries(entries) {
    return entries.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if ((a.invalid || 0) !== (b.invalid || 0)) return (a.invalid || 0) - (b.invalid || 0);
      if ((a.durationMs || 0) !== (b.durationMs || 0)) return (a.durationMs || 0) - (b.durationMs || 0);
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
  }

  return {
    SAVE_VERSION: SAVE_VERSION,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load, loadRaw: loadRaw, mergeDocs: mergeDocs, save: save, fresh: fresh, migrate: migrate,
    checksum: checksum,
    loadBoards: loadBoards, saveBoards: saveBoards, sortEntries: sortEntries
  };
});
