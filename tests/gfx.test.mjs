// Unit tests for the pure graphics quality model (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, autoPreset, resolve, choosePreset, setOverride, presetTier, describe
} from '../js/gfx.js';
import { pickLocale, strings, LOCALES } from '../js/gfx-panel.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2 Pro'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 730'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('autoPreset caps touch/mobile devices at balanced', () => {
  assert.equal(autoPreset('Apple M1', true), 'balanced');
  assert.equal(autoPreset('Apple M1', false), 'high');
  assert.equal(autoPreset('SwiftShader', true), 'low');
});

test('resolve: auto follows detection, explicit preset wins', () => {
  const a = resolve({}, 'high');
  assert.equal(a.preset, 'high'); assert.equal(a.auto, true);
  const l = resolve({ preset: 'low' }, 'high');
  assert.equal(l.preset, 'low'); assert.equal(l.auto, false);
  assert.equal(l.shadows, 'off'); assert.equal(l.post, false, 'Low needs no composer');
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: overrides apply per category, invalid tiers fall back to the preset', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'nope' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, true, 'bloom override turns the post chain on');
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'high' }).adaptive, true);
  assert.equal(resolve({ preset: 'high', show_fps: true }).showFps, true);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const s = setOverride({ preset: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'ao', 'off');
  assert.equal(s.ao, 'off');
  const c = choosePreset(s, 'low');
  assert.deepEqual(c, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(setOverride(s, 'ao', 'preset').ao, undefined);
});

test('every preset defines every category with a valid tier', () => {
  for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('describe summarises cost', () => {
  const d = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px$/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});

test('panel strings exist for every supported locale', () => {
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(LOCALES.includes(loc), loc);
    const S = strings(loc);
    for (const cat of Object.keys(CATEGORIES)) assert.ok(S.cats[cat], `${loc} cat ${cat}`);
    for (const tiers of Object.values(CATEGORIES)) for (const t of tiers) assert.ok(S.tiers[t], `${loc} tier ${t}`);
    for (const p of PRESETS) assert.ok(S.presets[p], `${loc} preset ${p}`);
    for (const k of ['quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postFailed']) assert.ok(S[k], `${loc} ${k}`);
  }
  assert.equal(pickLocale(['es-MX']), 'es-419');
  assert.equal(pickLocale(['fr-CA']), 'fr-CA');
  assert.equal(pickLocale(['en-GB']), 'en-GB');
  assert.equal(pickLocale(['ja-JP']), 'en-US');
});
