// i18n.test.js — every string the engine client (native/*.ts) shows exists in
// the nine StarHermit locales (js/i18n.js) with the placeholders of US
// English: the keys its code names, the keys it builds (refusal reasons,
// captions, screen names, modes, terminal reasons, content names, lessons,
// achievements) and every key of the US English table.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../js/i18n.js');
const C = require('../js/content.js');
const R = require('../js/rules.js');

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const dir = path.join(__dirname, '..', 'native');
const code = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const used = new Set();
for (const m of code.matchAll(/\btx?\("([A-Za-z0-9.\-]+)"(?!\s*\+)/g)) used.add(m[1]);
// keys built from data
// (the two shape refusals never reach a player's UI action; they show as inv.default)
for (const r of Object.values(R.INVALID)) if (!/^(unknown|malformed)-command$/.test(r)) used.add('inv.' + r);
used.add('inv.default');
for (const r of Object.values(R.TERMINAL)) used.add('term.' + r);
for (const c of ['select', 'gather', 'place-wood', 'place-stone', 'place-glass', 'place-plant', 'place-lamp', 'remove', 'invalid', 'goal', 'wave', 'win', 'lose', 'undo', 'hint', 'weather-rain', 'weather-cloud', 'round-start', 'lesson-complete', 'pause', 'resume']) used.add('cap.' + c);
for (const s of ['title', 'modes', 'setup', 'journey', 'learn', 'pause', 'results', 'settings', 'help', 'profile', 'leaderboard']) used.add('scr.' + s);
for (const m of ['learn', 'journey', 'daily', 'practice', 'challenge', 'score']) { used.add('mode.' + m); used.add('mode.' + m + '.d'); used.add('mode.' + m + '.m'); }
for (const h of ['goal', 'gather', 'place', 'support', 'toppers', 'remove', 'hints', 'camera', 'pause']) { used.add('h.' + h); used.add('h.' + h + '.b'); }
for (const b of ['wood', 'stone', 'glass', 'plant', 'lamp', 'rock']) used.add('block.' + b);
for (const c of C.JOURNEY) { used.add('lvl.' + c.id); if (c.intro) used.add('intro.' + c.id); }
for (const c of C.CHALLENGES) { used.add('ch.' + c.id); used.add('chi.' + c.id); }
for (const p of C.PRACTICE) used.add('prac.' + p.id);
for (const l of C.tutorialLessons()) { used.add('les.' + l.id); used.add('lest.' + l.id); }
for (const th of C.THEMES) used.add('theme.' + th.id);
for (const a of C.ACHIEVEMENTS) { used.add('ach.' + a.key); used.add('achd.' + a.key); }
for (const k of ['pal.standard', 'pal.high-visibility', 'score.name', 'score.intro', 'daily.name', 'daily.intro']) used.add(k);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine StarHermit locales', () => assert.deepEqual(I.LOCALES, LOCALES));
test('found the keys in code', () => assert.ok(used.size > 250, String(used.size)));
test('every key the code names is in US English', () => {
  assert.deepEqual([...used].filter((k) => typeof I.STRINGS['en-US'][k] !== 'string'), []);
});
for (const loc of LOCALES) {
  test(`${loc}: every used and every US English key, matching placeholders`, () => {
    const T = I.STRINGS[loc];
    const keys = new Set([...used, ...Object.keys(I.STRINGS['en-US'])]);
    assert.deepEqual([...keys].filter((k) => typeof T[k] !== 'string' || !T[k]), []);
    for (const k of keys) assert.equal(vars(T[k]), vars(I.STRINGS['en-US'][k]), `${loc}.${k}`);
  });
}
test('content names in US English are the authored data', () => {
  const en = I.STRINGS['en-US'];
  for (const c of C.JOURNEY) assert.equal(en['lvl.' + c.id], c.name);
  for (const a of C.ACHIEVEMENTS) assert.equal(en['ach.' + a.key], a.name);
});
test('the non-English locales are translated', () => {
  for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
    const same = [...used].filter((k) => I.STRINGS[loc][k] === I.STRINGS['en-US'][k] && !/^(lvl|ch|theme|key)\./.test(k));
    assert.ok(same.length < 30, `${loc}: ${same.join(', ')}`);
  }
});
test('setLocale switches and falls back to US English', () => {
  I.setLocale('de-DE');
  assert.equal(I.lang, 'de-DE');
  assert.equal(I.t('acct.signIn'), 'Mit StarHermit anmelden');
  I.setLocale('xx-YY');
  assert.equal(I.lang, 'en-US');
  assert.equal(I.t('moves.limit', { n: 3, max: 20 }), 'Moves 3/20');
});
