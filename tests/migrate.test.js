// migrate.test.js — the engine save document and what the browser build left
// in the player's account (js/migrate.js): the foreign cloud save (the SDK's
// checksummed { sum, payload } document) read and merged, the engine save's
// conflict merge, and the per-player settings kept or dropped. The signed-in
// paths cannot run here (no account), so their logic is covered by these.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');
const M = require('../js/migrate.js');

/** The browser build's cloud save text: S.save's wrapped string. */
function browserSave(doc) {
  const payload = JSON.stringify(doc);
  return JSON.stringify({ sum: S.checksum(payload), payload });
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('the browser build\'s cloud save reads back whole', () => {
  const doc = S.fresh();
  doc.progress.journeyStars.j01 = 3;
  doc.progress.stats.placed = 42;
  doc.progress.endlessBest = 900;
  doc.settings.theme = 'frost';
  doc.settings.music = 0.2;
  const back = M.docFromBrowserSave(browserSave(doc));
  assert.equal(back.progress.journeyStars.j01, 3);
  assert.equal(back.progress.stats.placed, 42);
  assert.equal(back.progress.endlessBest, 900);
  assert.equal(back.settings.theme, 'frost');
});
test('a pre-graphics browser save (graphicsTier) still reads', () => {
  const doc = S.fresh();
  delete doc.settings.gfx;
  doc.settings.graphicsTier = 'medium';
  const back = M.docFromBrowserSave(browserSave(doc));
  assert.equal(back.settings.gfx.preset, 'balanced');
  assert.equal(back.settings.graphicsTier, undefined);
});
test('a corrupt or future browser save is refused', () => {
  assert.equal(M.docFromBrowserSave('not json'), null);
  assert.equal(M.docFromBrowserSave(JSON.stringify({ sum: 'x', payload: '{}' })), null);
  assert.equal(M.docFromBrowserSave(browserSave({ v: 99, progress: {} })), null);
  assert.equal(M.docFromBrowserSave(null), null);
});
test('the engine save document round-trips its progress', () => {
  const p = S.fresh().progress;
  p.dailiesDone['2026-10-01'] = 820;
  const doc = plain(M.saveDoc(p));
  assert.equal(doc.v, 1);
  assert.equal(M.progressFromSave(doc).dailiesDone['2026-10-01'], 820);
  assert.equal(M.progressFromSave({ v: 2, progress: p }), null);
  assert.equal(M.progressFromSave(null), null);
  assert.equal(M.progressFromSave({ v: 1, progress: [] }), null);
});
test('two devices\' progress merges: better records, every achievement at its earliest', () => {
  const a = S.fresh().progress, b = S.fresh().progress;
  a.journeyStars = { j01: 3, j02: 1 }; b.journeyStars = { j02: 2, j03: 1 };
  a.challengeBest = { c1: 800 }; b.challengeBest = { c1: 950 };
  a.tutorialDone = { t1: true }; b.tutorialDone = { t2: true };
  a.endlessBest = 1200; b.endlessBest = 1500;
  a.stats.rounds = 7; b.stats.rounds = 4; a.stats.bestHeight = 3; b.stats.bestHeight = 5;
  a.stats.funnel = { boot: 3 }; b.stats.funnel = { boot: 9 };
  a.achievements = { 'first-win': 200 }; b.achievements = { 'first-win': 100, 'tower-5': 300 };
  const m = plain(M.mergeProgress(a, b));
  assert.deepEqual(m.journeyStars, { j01: 3, j02: 2, j03: 1 });
  assert.equal(m.challengeBest.c1, 950);
  assert.deepEqual(m.tutorialDone, { t1: true, t2: true });
  assert.equal(m.endlessBest, 1500);
  assert.equal(m.stats.rounds, 7);
  assert.equal(m.stats.bestHeight, 5);
  assert.deepEqual(m.stats.funnel, { boot: 9 }, 'the local device\'s counters stay its own');
  assert.deepEqual(m.achievements, { 'first-win': 100, 'tower-5': 300 });
  assert.deepEqual(plain(M.mergeProgress(null, null)), plain(S.fresh().progress));
  assert.equal(M.mergeProgress(a, null).journeyStars.j01, 3);
});
test('the browser build\'s settings: the game\'s own options carry over, the runtime\'s are dropped', () => {
  assert.equal(M.migrateSetting('captions', true), true);
  assert.equal(M.migrateSetting('theme', 'nightfall'), 'nightfall');
  assert.equal(M.migrateSetting('theme', 'plaid'), undefined);
  assert.equal(M.migrateSetting('colorPalette', 'high-visibility'), 'high-visibility');
  assert.equal(M.migrateSetting('confirmMoves', true), true);
  assert.equal(M.migrateSetting('boardMirror', 1), undefined);
  for (const k of ['music', 'effects', 'ambience', 'voice', 'muted', 'gfx', 'reducedMotion', 'highContrast', 'largeText', 'ui.language', 'graphicsTier']) {
    assert.ok(M.BROWSER_SETTING_KEYS.includes(k), k);
    assert.equal(M.migrateSetting(k, 0.5), undefined, k);
  }
  assert.deepEqual(M.GAME_SETTING_KEYS, ['captions', 'theme', 'colorPalette', 'leftHanded', 'haptics', 'boardMirror', 'confirmMoves']);
  for (const k of M.GAME_SETTING_KEYS) assert.notEqual(M.migrateSetting(k, S.DEFAULT_SETTINGS[k]), undefined, k);
});
