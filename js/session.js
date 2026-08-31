/* Blockstead — session layer: validated commands with ids, undo stack,
 * replay envelope (schema version, seed, initial hash, ordered commands,
 * periodic state hashes, terminal result) and replay verification.
 * Shared browser (window.BSSession) / Node — the server uses the same
 * code to authoritatively validate submitted score logs.
 */
(function (root, factory) {
  var Rules = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.BSRules;
  var api = factory(Rules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSSession = api;
})(typeof self !== 'undefined' ? self : this, function (Rules) {
  'use strict';

  var ENVELOPE_VERSION = 1;
  var HASH_EVERY = 8; // record a state hash every N accepted commands

  // createSession(cfg) -> session. cfg is a content config (see content.js).
  function createSession(cfg) {
    var state = Rules.createGame(cfg);
    return {
      cfg: Rules.clone(cfg),
      state: state,
      initialHash: Rules.hashState(state),
      log: [],          // accepted commands, in order
      hashes: [],       // [{n, hash}] every HASH_EVERY commands
      undoStack: [],    // [{stateJson, logLen}] previous snapshots
      invalid: 0,       // rejected command count (tie-breaker + anti-cheat signal)
      seq: 0,
      terminal: null
    };
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? Math.floor(performance.now()) : Date.now();
  }

  // Execute one command. Fields: {type, x?, y?, block?, id?}.
  // Returns {ok, reason?, events, state}. Duplicate command ids are
  // rejected idempotently: the stored result is replayed, state untouched.
  function execute(session, fields, atMs) {
    var s = session;
    // Idempotent duplicate rejection by command id (checked before the
    // terminal guard so a retried final command still returns success).
    if (s.log.length && fields && typeof fields.id === 'string') {
      for (var d = 0; d < s.log.length; d++) {
        if (s.log[d].id === fields.id) {
          return { ok: true, duplicate: true, events: [], state: s.state };
        }
      }
    }
    if (s.terminal) {
      return { ok: false, reason: Rules.INVALID.ENDED, events: [], state: s.state, duplicate: false };
    }
    var cmd = { type: fields && fields.type };
    if (fields.x != null) cmd.x = fields.x;
    if (fields.y != null) cmd.y = fields.y;
    if (fields.block != null) cmd.block = fields.block;
    cmd.id = (typeof fields.id === 'string' && fields.id) ? fields.id
      : 'c' + (++s.seq) + '-' + (s.cfg.seed >>> 0).toString(36);
    cmd.atMs = (typeof atMs === 'number') ? atMs : nowMs();

    var shapeErr = Rules.validateCommandShape(cmd);
    if (shapeErr) { s.invalid++; return { ok: false, reason: shapeErr, events: [], state: s.state }; }

    var res = Rules.applyCommand(s.state, cmd);
    if (!res.ok) { s.invalid++; return { ok: false, reason: res.reason, events: [], state: s.state }; }

    // Undo snapshot (before mutation), only where the ruleset permits.
    if (s.cfg.mechanics && s.cfg.mechanics.undo !== false) {
      s.undoStack.push({ stateJson: Rules.serialize(s.state), logLen: s.log.length });
      if (s.undoStack.length > 200) s.undoStack.shift();
    }

    s.state = res.state;
    s.log.push(cmd);
    if (s.log.length % HASH_EVERY === 0) {
      s.hashes.push({ n: s.log.length, hash: Rules.hashState(s.state) });
    }
    if (s.state.terminal) {
      s.terminal = s.state.terminal;
      s.hashes.push({ n: s.log.length, hash: Rules.hashState(s.state) });
    }
    return { ok: true, duplicate: false, events: res.events, state: s.state, command: cmd };
  }

  // Undo restores the exact pre-command snapshot and truncates the log so
  // replays stay linear. Not a rules command — it is a session convenience
  // permitted only when cfg.mechanics.undo is on and the round is live.
  function canUndo(session) {
    return !!(session && !session.terminal &&
      session.cfg.mechanics && session.cfg.mechanics.undo !== false &&
      session.undoStack.length);
  }
  function undo(session) {
    if (!canUndo(session)) return { ok: false };
    var snap = session.undoStack.pop();
    session.state = Rules.deserialize(snap.stateJson);
    session.log.length = snap.logLen;
    session.hashes = session.hashes.filter(function (h) { return h.n <= snap.logLen; });
    return { ok: true, state: session.state };
  }

  // Replay envelope for validation / leaderboards.
  function envelope(session) {
    return {
      v: ENVELOPE_VERSION,
      contentVersion: session.cfg.version,
      contentId: session.cfg.id,
      kind: session.cfg.kind,
      seed: session.cfg.seed >>> 0,
      initialHash: session.initialHash,
      commands: session.log.slice(),
      hashes: session.hashes.slice(),
      invalid: session.invalid,
      elapsedMs: session.state.elapsedMs,
      terminal: session.terminal,
      score: Rules.clone(session.state.score)
    };
  }

  // Authoritative verification: rebuild from cfg, replay ordered commands,
  // check initial hash, periodic hashes, terminal and score. `cfg` must be
  // rebuilt by the caller from trusted content (never from the client).
  function verify(cfg, env) {
    if (!env || env.v !== ENVELOPE_VERSION) return { ok: false, reason: 'bad-envelope' };
    if (!cfg || cfg.version !== env.contentVersion) return { ok: false, reason: 'stale-version' };
    if ((cfg.seed >>> 0) !== (env.seed >>> 0)) return { ok: false, reason: 'seed-mismatch' };
    var session = createSession(cfg);
    if (session.initialHash !== env.initialHash) return { ok: false, reason: 'initial-hash-mismatch' };
    if (!Array.isArray(env.commands) || env.commands.length > 5000) {
      return { ok: false, reason: 'bad-command-log' };
    }
    for (var i = 0; i < env.commands.length; i++) {
      var cmd = env.commands[i];
      if (Rules.validateCommandShape(cmd)) return { ok: false, reason: 'bad-command-shape' };
      var res = Rules.applyCommand(session.state, cmd);
      if (!res.ok) return { ok: false, reason: 'illegal-command-' + i };
      session.state = res.state;
    }
    for (var h = 0; h < env.hashes.length; h++) {
      var n = env.hashes[h].n;
      // recompute hash at that prefix
      var check = createSession(cfg);
      for (var j = 0; j < n; j++) check.state = Rules.applyCommand(check.state, env.commands[j]).state;
      if (Rules.hashState(check.state) !== env.hashes[h].hash) {
        return { ok: false, reason: 'hash-mismatch-' + n };
      }
    }
    var finalHash = Rules.hashState(session.state);
    var claimed = env.hashes.length ? env.hashes[env.hashes.length - 1].hash : env.initialHash;
    if (!env.hashes.length && env.commands.length) return { ok: false, reason: 'no-hashes' };
    if (env.terminal && !session.state.terminal) return { ok: false, reason: 'terminal-mismatch' };
    if (env.terminal && session.state.terminal &&
        env.terminal.reason !== session.state.terminal.reason) {
      return { ok: false, reason: 'terminal-mismatch' };
    }
    var actual = session.state.score.total;
    if (!env.score || env.score.total !== actual) return { ok: false, reason: 'score-mismatch' };
    return { ok: true, finalHash: finalHash, claimedHash: claimed, score: actual, state: session.state };
  }

  return {
    ENVELOPE_VERSION: ENVELOPE_VERSION,
    createSession: createSession,
    execute: execute,
    canUndo: canUndo,
    undo: undo,
    envelope: envelope,
    verify: verify
  };
});
