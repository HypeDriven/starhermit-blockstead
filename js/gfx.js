/* Blockstead — graphics quality model (pure; no three.js import).
 * Presets, per-category overrides, GPU detection and a cost summary, shared
 * by the renderer and the Graphics settings panel so both agree on what a
 * setting means. Saved shape (settings.gfx):
 *   { preset: 'auto'|preset, render_scale: 0.5..2, adaptive, show_fps,
 *     <category>: tier }   — a missing/unknown category value = "from preset".
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  detail: ['plain', 'detailed'],
  particles: ['off', 'low', 'high'],
  background: ['static', 'animated'],
};

// Each preset is a row of tiers plus a render scale (multiplies the device
// pixel ratio) and a device-pixel-ratio cap (Low renders at 1x like the
// original low tier).
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'off', background: 'static' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'low', background: 'animated' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

export const DEFAULTS = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };

// StarHermit hardware level (0–20, gpu-level.js) at which Auto starts choosing each preset.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

// Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the
// preset (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070;
// Ultra: level 17 RTX 4080). Gameplay is identical on every preset.
//   hudBlur   — frosted-glass HUD (CSS backdrop blur re-composited over the live 3D view every frame);
//               off below High, where the panels use a more opaque backing instead
//   glossy    — clearcoat on glass, lamps and the pond (else plain PBR)
//   bevel     — rounded-block bevel segments with Surface detail on
//   texture   — procedural surface texture size in px (wood, stone, leaf, grass, soil, lamp)
//   rain      — rain drops for Particles high (Particles low uses 40 %), scaled by hardware level
//   motes     — pollen motes (Particles high)
//   clouds    — cloud clusters in the sky (Surface detail on)
//   bloomRes  — bloom resolution as a fraction of the canvas
export const BUDGETS = {
  low: { hudBlur: false, glossy: false, bevel: 1, texture: 64, rain: 600, motes: 0, clouds: 3, bloomRes: 0.5 },
  balanced: { hudBlur: false, glossy: false, bevel: 2, texture: 128, rain: 1000, motes: 30, clouds: 5, bloomRes: 0.5 },
  high: { hudBlur: true, glossy: true, bevel: 2, texture: 128, rain: 1600, motes: 60, clouds: 7, bloomRes: 0.75 },
  ultra: { hudBlur: true, glossy: true, bevel: 4, texture: 256, rain: 3200, motes: 120, clouds: 10, bloomRes: 1 },
};

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for a renderer string (+ optional detectSystem() fields such as mobile). */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  return G ? G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') }) : 0;
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (hardware level → preset). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Auto choice for a GPU; phones and tablets are capped at Balanced by the hardware level. */
export function autoPreset(gpu, mobile) {
  return detectPreset(gpu, { mobile: !!mobile });
}

/** The preset's budget; rain and motes scale by the level within the preset (≤ 2×). */
export function budget(preset, level) {
  const b = BUDGETS[preset] || BUDGETS.balanced;
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
  return { ...b, rain: Math.round(b.rain * k), motes: Math.round(b.motes * k) };
}

/** Resolve saved settings into concrete tiers. */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
    dprCap: row.dprCap,
  };
  out.scale = row.scale * out.renderScale;
  for (const cat of Object.keys(CATEGORIES)) {
    out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budget(preset, level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it; otherwise the canvas's
  // own MSAA is used and Low costs no more than a plain render.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
    out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Picking a preset clears every override (and keeps scale/adaptive/fps). */
export function choosePreset(saved, preset) {
  const s = saved || {};
  return {
    preset: PRESETS.includes(preset) ? preset : 'auto',
    render_scale: s.render_scale != null ? s.render_scale : 1,
    adaptive: s.adaptive !== false,
    show_fps: !!s.show_fps,
  };
}

/** Set one category override ('preset' or unknown value removes it). */
export function setOverride(saved, cat, tier) {
  const s = Object.assign({}, saved || {});
  if (CATEGORIES[cat] && CATEGORIES[cat].includes(tier)) s[cat] = tier;
  else delete s[cat];
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  const row = TABLE[preset];
  return row ? row[cat] : undefined;
}

const WORDS_EN = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing',
};

/** Short cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels, words) {
  const w = Object.assign({}, WORDS_EN, words || {});
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoFull : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
