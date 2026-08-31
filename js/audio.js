/* Blockstead — WebAudio: authored one-shot samples per logical event
 * (sfx/<name>.opus, see sfx/manifest.json) with procedural synthesis as
 * fallback while a sample is loading or unavailable. Valley ambience
 * (wind + birds) and the adaptive music pad stay fully synthesized.
 * Browser global: BSAudio.
 */
(function (root) {
  'use strict';

  var ctx = null, master = null;
  var buses = {}; // music, effects, ambience, voice
  var settings = { music: 0.55, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false };
  var captions = false;
  var captionFn = null;
  var started = false;
  var musicTimer = null, birdTimer = null, ambienceNodes = null;
  var avRng = null; // seeded variants for replay consistency
  var weather = 'sun'; // sun | cloud | rain — ambience intensity only

  function ensureCtx() {
    if (ctx) return true;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = settings.muted ? 0 : (settings[name] != null ? settings[name] : 0.8);
      g.connect(master);
      buses[name] = g;
    });
    return true;
  }

  function applySettings(s) {
    Object.assign(settings, s || {});
    if (!ctx) return;
    Object.keys(buses).forEach(function (name) {
      var v = settings.muted ? 0 : (settings[name] != null ? settings[name] : 0.8);
      buses[name].gain.setTargetAtTime(v, ctx.currentTime, 0.05);
    });
  }

  function caption(text) {
    if (captions && captionFn && text) captionFn(text);
  }

  // ---------- primitive builders ----------
  function blip(freq, dur, type, gain, bus, when, sweepTo) {
    var t = (when || ctx.currentTime);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus || 'effects']);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function thud(dur, gain, cutoff, when) { // filtered noise = material impact
    var t = when || ctx.currentTime;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(buses.effects);
    src.start(t);
  }

  function variant(base) { // seeded pitch variant (±6%) when replay consistency matters
    var r = avRng ? avRng.next() : Math.random();
    return base * (0.94 + r * 0.12);
  }

  // Material impact per block type (layered transients).
  function materialThud(block) {
    if (block === 'wood') { thud(0.08, 0.5, 800); blip(variant(190), 0.07, 'sine', 0.1); }
    else if (block === 'stone') { thud(0.1, 0.6, 500); blip(variant(120), 0.09, 'sine', 0.12); }
    else if (block === 'glass') { blip(variant(1180), 0.12, 'sine', 0.1); blip(variant(1760), 0.09, 'sine', 0.05, 'effects', ctx.currentTime + 0.03); thud(0.05, 0.25, 2400); }
    else if (block === 'plant') { thud(0.06, 0.3, 1600); blip(variant(340), 0.06, 'triangle', 0.08); }
    else if (block === 'lamp') { blip(variant(660), 0.14, 'sine', 0.1); blip(variant(990), 0.12, 'sine', 0.06, 'effects', ctx.currentTime + 0.05); }
    else thud(0.09, 0.5, 900);
  }

  // ---------- event map ----------
  var SFX = {
    'ui':        function () { blip(660, 0.06, 'triangle', 0.12); },
    'select':    function () { blip(variant(520), 0.08, 'sine', 0.14); },
    'deselect':  function () { blip(390, 0.07, 'sine', 0.1); },
    'gather':    function () {
      thud(0.07, 0.35, 1200);
      blip(variant(440), 0.09, 'triangle', 0.1, 'effects', ctx.currentTime + 0.04);
      blip(variant(560), 0.09, 'triangle', 0.08, 'effects', ctx.currentTime + 0.1);
    },
    'place-wood':  function () { materialThud('wood'); },
    'place-stone': function () { materialThud('stone'); },
    'place-glass': function () { materialThud('glass'); },
    'place-plant': function () { materialThud('plant'); },
    'place-lamp':  function () { materialThud('lamp'); },
    'remove':    function () { thud(0.08, 0.4, 700); blip(variant(300), 0.08, 'sine', 0.09, 'effects', ctx.currentTime + 0.02, 200); },
    'invalid':   function () { blip(160, 0.16, 'square', 0.07); blip(150, 0.14, 'square', 0.05, 'effects', ctx.currentTime + 0.05); },
    'goal':      function () {
      blip(523, 0.25, 'sine', 0.13); blip(784, 0.3, 'sine', 0.11, 'effects', ctx.currentTime + 0.1);
    },
    'wave':      function () {
      [0, 5, 9].forEach(function (st, i) {
        blip(variant(440 * Math.pow(2, st / 12)), 0.2, 'sine', 0.1, 'effects', ctx.currentTime + i * 0.06);
      });
    },
    'win':       function () {
      [0, 4, 7, 12].forEach(function (st, i) {
        blip(523 * Math.pow(2, st / 12), 0.5, 'triangle', 0.13, 'effects', ctx.currentTime + i * 0.12);
      });
    },
    'lose':      function () { blip(300, 0.5, 'sine', 0.15, 'effects', ctx.currentTime, 180); blip(200, 0.6, 'sine', 0.1, 'effects', ctx.currentTime + 0.15, 120); },
    'undo':      function () { blip(500, 0.08, 'triangle', 0.1, 'effects', ctx.currentTime, 380); },
    'hint':      function () { blip(990, 0.12, 'sine', 0.1); blip(1320, 0.14, 'sine', 0.07, 'effects', ctx.currentTime + 0.07); },
    'star':      function () { blip(1568, 0.18, 'sine', 0.1); },
    'weather-rain': function () { /* sample-only event; ambience reacts via setWeather */ }
  };

  // Captions fire per logical event, independent of sample vs synthesis.
  var CAPTIONS = {
    'select': 'select', 'gather': 'gathered resources',
    'place-wood': 'timber placed', 'place-stone': 'stone placed',
    'place-glass': 'glass placed', 'place-plant': 'plant placed',
    'place-lamp': 'lamp placed', 'remove': 'block removed',
    'invalid': 'not allowed', 'goal': 'goal complete', 'wave': 'new goals',
    'win': 'stage complete', 'lose': 'round lost', 'undo': 'undo',
    'hint': 'hint', 'weather-rain': 'rain begins'
  };

  // ---------- authored samples: event -> sfx/<name>.opus ----------
  // Lazy-fetched and decoded on first play (after start()'s user-gesture
  // unlock), then cached. Synthesis above runs while loading/on failure.
  var SAMPLE_EVENTS = {
    'ui': 'ui',
    'select': 'select',
    'deselect': 'deselect',
    'gather': 'gather',
    'place-wood': 'place-wood',
    'place-stone': 'place-stone',
    'place-glass': 'place-glass',
    'place-plant': 'place-plant',
    'place-lamp': 'place-lamp',
    'remove': 'remove',
    'invalid': 'invalid',
    'goal': 'goal',
    'wave': 'wave',
    'win': 'win',
    'lose': 'lose',
    'undo': 'undo',
    'hint': 'hint',
    'star': 'star',
    'weather-rain': 'weather-rain'
  };
  var samples = {}; // name -> { state: 'loading'|'ready'|'failed', buffer }

  function playSample(name) { // true when a decoded sample was played
    var s = samples[name];
    if (s && s.state === 'ready') {
      var src = ctx.createBufferSource();
      src.buffer = s.buffer;
      src.connect(buses.effects);
      src.start();
      return true;
    }
    if (!s) {
      s = samples[name] = { state: 'loading', buffer: null };
      fetch('sfx/' + name + '.opus').then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.arrayBuffer();
      }).then(function (ab) {
        return ctx.decodeAudioData(ab);
      }).then(function (buf) {
        s.buffer = buf;
        s.state = 'ready';
      }).catch(function () {
        s.state = 'failed'; // keep synthesis fallback permanently
      });
    }
    return false;
  }

  function play(name) {
    if (!started || !ctx || settings.muted) return;
    if (ctx.state === 'suspended') ctx.resume();
    caption(CAPTIONS[name]);
    if (SAMPLE_EVENTS[name] && playSample(SAMPLE_EVENTS[name])) return;
    var fn = SFX[name];
    if (fn) fn();
  }

  // ---------- ambience: valley wind (filtered brown noise) + birds ----------
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    var g = ctx.createGain(); g.gain.value = 0.3;
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src, gain: g, filter: f };
    scheduleBirds();
  }

  function scheduleBirds() { // sparse chirps in fair weather only
    if (birdTimer) clearTimeout(birdTimer);
    var delay = 3000 + Math.random() * 7000;
    birdTimer = setTimeout(function () {
      if (started && ctx && !settings.muted && weather !== 'rain') {
        var base = 1800 + Math.random() * 1200;
        var n = 2 + Math.floor(Math.random() * 3);
        for (var i = 0; i < n; i++) {
          blip(base * (0.9 + Math.random() * 0.2), 0.09, 'sine', 0.045, 'ambience',
            ctx.currentTime + i * 0.12, base * 1.3);
        }
      }
      scheduleBirds();
    }, delay);
  }

  function setWeather(w) { // cosmetic; adjusts wind level only
    if (w === weather) return;
    weather = w;
    if (ambienceNodes && ctx) {
      var target = w === 'rain' ? 0.55 : w === 'cloud' ? 0.4 : 0.3;
      ambienceNodes.gain.gain.setTargetAtTime(target, ctx.currentTime, 1.2);
      ambienceNodes.filter.frequency.setTargetAtTime(w === 'rain' ? 700 : 300, ctx.currentTime, 1.2);
    }
  }

  // ---------- music: slow generative pad, seeded chord walk ----------
  var CHORDS = [
    [261.63, 329.63, 392.0],  // C  E  G
    [220.0, 261.63, 329.63],  // A  C  E
    [174.61, 220.0, 261.63],  // F  A  C
    [196.0, 246.94, 293.66]   // G  B  D
  ];
  var chordIdx = 0;
  function schedulePad() {
    if (!ctx || settings.muted) return;
    var t = ctx.currentTime + 0.1;
    var chord = CHORDS[chordIdx % CHORDS.length];
    chordIdx++;
    chord.forEach(function (freq, i) {
      var o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = freq * 0.5;
      f.type = 'lowpass'; f.frequency.value = 650;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 2.0);
      g.gain.linearRampToValueAtTime(0.0001, t + 6.8);
      o.connect(f); f.connect(g); g.connect(buses.music);
      o.start(t); o.stop(t + 7.0);
    });
  }
  function startMusic() {
    if (musicTimer || !ctx) return;
    schedulePad();
    musicTimer = setInterval(schedulePad, 5600);
  }

  function start() {
    if (!ensureCtx()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    startAmbience();
    startMusic();
    return true;
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (ctx && started && ctx.state === 'suspended') ctx.resume(); }

  function setAvRng(rng) { avRng = rng; }
  function setCaptions(on, fn) { captions = !!on; captionFn = fn || captionFn; }

  root.BSAudio = {
    start: start, play: play, applySettings: applySettings,
    suspend: suspend, resume: resume, setAvRng: setAvRng, setCaptions: setCaptions,
    setWeather: setWeather,
    isStarted: function () { return started; }
  };
})(typeof self !== 'undefined' ? self : this);
