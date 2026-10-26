/* Blockstead — the save document of the engine client and what the browser
 * build (starhermit-sdk.js) left in the player's account, as the engine
 * client takes it over (pure: no storage).
 *  - The engine save (starhermit:storage `saves`) is { v: 1, progress }: the
 *    browser build's progress document (BSStore), merged across devices by
 *    BSStore.mergeDocs (more stars, better bests, the larger lifetime
 *    counters, every achievement with its earliest unlock).
 *  - The browser build's cloud save (slot game:<slug>) holds the SDK's
 *    save.json: the checksummed { sum, payload } wrapper of the whole
 *    document { v, settings, progress }. The engine shows it as a foreign
 *    save; docFromBrowserSave reads it, its progress is merged in and its
 *    game settings are kept where this account has none yet.
 *  - The per-player settings keys (the SDK's PATCH of the settings object):
 *    the game's own options carry over as game settings; volumes, mute,
 *    graphics, reduced motion, high contrast, larger text and the language
 *    are the runtime's Options now and are dropped.
 * UMD: globalThis.BSMigrate (loadClassic, after js/store.js) / Node.
 */
(function (root, factory) {
  var S = (typeof module === 'object' && module.exports) ? require('./store.js') : root.BSStore;
  var api = factory(S);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSMigrate = api;
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  function bool(v) { return typeof v === 'boolean'; }
  /** Settings the game still owns (game.<key> in the runtime's settings), with their checks. */
  var GAME_SETTINGS = {
    captions: bool,
    theme: function (v) { return typeof v === 'string' && /^(meadow|ember|frost|canyon|nightfall)$/.test(v); },
    colorPalette: function (v) { return v === 'standard' || v === 'high-visibility'; },
    leftHanded: bool,
    haptics: bool,
    boardMirror: bool,
    confirmMoves: bool
  };
  var GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
  /** Every key the browser build kept in the account's per-player settings. */
  var BROWSER_SETTING_KEYS = Object.keys(S.DEFAULT_SETTINGS).concat(['graphicsTier', 'ui.language']);

  function isProgress(p) {
    return !!(p && typeof p === 'object' && !Array.isArray(p) && p.stats && typeof p.stats === 'object');
  }

  /** The progress in an engine save document ({ v: 1, progress }), or null. */
  function progressFromSave(doc) {
    if (!doc || typeof doc !== 'object' || doc.v !== 1 || !isProgress(doc.progress)) return null;
    return S.migrate({ v: 1, progress: JSON.parse(JSON.stringify(doc.progress)) }).progress;
  }

  /** The whole browser-build document ({ v, settings, progress }) in its cloud save text, or null. */
  function docFromBrowserSave(text) {
    if (typeof text !== 'string') return null;
    return S.loadRaw(text);
  }

  /** The engine save document for a progress object. */
  function saveDoc(progress) { return { v: 1, progress: progress }; }

  /** Two progress objects merged (either may be null); a fresh one when both are. */
  function mergeProgress(remote, local) {
    return S.mergeDocs(remote ? { v: 1, progress: remote } : null, local ? { v: 1, progress: local } : null).progress;
  }

  /** A browser-build setting's value as the engine client keeps it, or undefined (dropped). */
  function migrateSetting(key, value) {
    var check = GAME_SETTINGS[key];
    if (!check) return undefined;
    return check(value) ? value : undefined;
  }

  return {
    GAME_SETTING_KEYS: GAME_SETTING_KEYS, BROWSER_SETTING_KEYS: BROWSER_SETTING_KEYS,
    progressFromSave: progressFromSave, docFromBrowserSave: docFromBrowserSave,
    saveDoc: saveDoc, mergeProgress: mergeProgress, migrateSetting: migrateSetting
  };
});
