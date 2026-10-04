/* Blockstead — StarHermit host adapter over window.StarHermit
 * (starhermit-sdk.js, loaded first). Covers the
 * launch token, identity, cloud-save mirror, settings mirror, sign-in,
 * invite link and keyboard bindings. Every call is a no-op when the game
 * runs standalone (no launch token): localStorage stays the only save, no
 * request is made and offline play is unchanged.
 * Browser global: window.BSPlatform. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSPlatform = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var SH = root.StarHermit;
  // Read the launch fragment as early as possible (classic script, before
  // any module touches the URL).
  if (SH && !SH.__bsInit) { SH.init(); SH.__bsInit = true; }

  var profile = null;          // { displayName }
  var sync = 'offline';        // offline | saving | synced
  var loaded = false;          // remote save + settings read finished
  var pendingSave = null;      // wrapped save string awaiting load completion
  var pushedSettings = null;   // last settings object mirrored to the KV store
  var platformSettings = null; // settings read from the KV store at start
  var listeners = { profile: [], sync: [], auth: [] };

  function hosted() { return !!(SH && SH.signedIn); }
  function notify(kind, value) {
    var fns = listeners[kind];
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](value); } catch (e) { /* listener errors never break the adapter */ }
    }
  }
  function setSync(state) {
    if (sync === state) return;
    sync = state;
    notify('sync', sync);
  }

  // ---------- settings KV mirror ----------
  function settingsOf(wrapped) {
    try {
      var w = JSON.parse(wrapped);
      var d = JSON.parse(w.payload);
      return d && d.settings && typeof d.settings === 'object' ? d.settings : null;
    } catch (e) { return null; }
  }
  function mirrorSettings(settings) {
    if (!settings || !hosted()) return;
    var base = pushedSettings || platformSettings || {};
    var patch = {}, any = false;
    Object.keys(settings).forEach(function (k) {
      if (JSON.stringify(settings[k]) !== JSON.stringify(base[k])) { patch[k] = settings[k]; any = true; }
    });
    pushedSettings = JSON.parse(JSON.stringify(settings));
    if (any) SH.patchSettings(patch);
  }

  // Called by BSStore.save with the wrapped local save string.
  function onLocalSave(wrapped) {
    if (!hosted()) return;
    if (!loaded) { pendingSave = wrapped; return; }
    mirrorSettings(settingsOf(wrapped));
    setSync('saving');
    SH.saveJSON(JSON.parse(wrapped));
  }

  function flushCloud() {
    if (!hosted()) return Promise.resolve(false);
    return SH.flushSave(true);
  }

  // ---------- boot ----------
  // Resolves with the wrapped remote save string when one exists (remote wins
  // over local), or null. opts.onProfile / onSync / onAuth fire on updates.
  function init(opts) {
    opts = opts || {};
    if (typeof opts.onProfile === 'function') listeners.profile.push(opts.onProfile);
    if (typeof opts.onSync === 'function') listeners.sync.push(opts.onSync);
    if (typeof opts.onAuth === 'function') listeners.auth.push(opts.onAuth);
    if (!SH) return Promise.resolve(null);

    SH.on('saved', function (ok) { if (hosted()) setSync(ok ? 'synced' : 'offline'); });
    SH.on('auth', function (a) {
      if (!a.signedIn) { profile = null; setSync('offline'); }
      notify('auth', a);
    });
    if (!hosted()) { setSync('offline'); return Promise.resolve(null); }

    try {
      root.addEventListener('pagehide', function () { flushCloud(); });
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.hidden) flushCloud();
      });
    } catch (e) { /* no window events available */ }

    SH.profile().then(function (p) {
      if (!p) return;
      profile = { displayName: String(p.displayName).slice(0, 40) };
      notify('profile', profile);
    });

    return Promise.all([SH.loadJSON(), SH.getSettings()]).then(function (r) {
      var remote = r[0];
      var s = r[1];
      platformSettings = s && Object.keys(s).length ? s : null;
      loaded = true;
      setSync('synced');
      var raw = remote && typeof remote.payload === 'string' ? JSON.stringify(remote) : null;
      if (pendingSave != null && !raw) { var p = pendingSave; pendingSave = null; onLocalSave(p); }
      pendingSave = null;
      return raw;
    }, function () { loaded = true; return null; });
  }

  // ---------- identity for board rows ----------
  /** Nickname for any user id (cached by the SDK); "Player <id8>" signed out. */
  function profileFor(uid) {
    if (!uid || typeof uid !== 'string') return Promise.resolve('player');
    var fallback = 'Player ' + uid.slice(0, 8);
    if (!hosted()) return Promise.resolve(fallback);
    return SH.profile(uid).then(function (p) { return p && p.nickname || fallback; }, function () { return fallback; });
  }

  // ---------- sign-in, invite, controls ----------
  function canSignIn() { return !!(SH && SH.canSignIn()); }
  function signIn() { return !!(SH && SH.signIn()); }
  function inviteLink() { return hosted() ? SH.inviteLink() : null; }
  /** defaults: { action: ['Code', ...] } → effective bindings (platform overrides). */
  function loadBindings(defaults) {
    if (!SH || !hosted()) return Promise.resolve(JSON.parse(JSON.stringify(defaults)));
    return SH.loadBindings(defaults).catch(function () { return JSON.parse(JSON.stringify(defaults)); });
  }

  return {
    init: init,
    onLocalSave: onLocalSave,
    flushCloud: flushCloud,
    canSignIn: canSignIn,
    signIn: signIn,
    inviteLink: inviteLink,
    loadBindings: loadBindings,
    profileFor: profileFor,
    /** Current launch token (renewed by the SDK) or null. */
    get token() { return hosted() ? SH.token : null; },
    get userId() { return hosted() ? SH.userId : null; },
    get hosted() { return hosted(); },
    get profile() { return profile; },
    get sync() { return sync; },
    /** Settings stored on the platform at start (null when none / standalone). */
    get platformSettings() { return platformSettings; }
  };
});
