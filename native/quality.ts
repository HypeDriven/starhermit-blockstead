// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, bevels, textures, reflections, detail, motion)
// is the browser build's four presets (js/gfx.js TABLE / BUDGETS) keyed by
// the level's quality tier, with the rain drops and pollen motes scaled
// within the tier by the level's particle budget against the tier's anchor
// level (quantum, molecular, terrestrial, galactic), at most twice. The
// runtime owns what the old Graphics panel did besides: Auto and the level
// choice, render scale and the pixel-ratio cap, adaptive resolution and the
// frame-rate limit and readout. The frosted-glass HUD (High and Ultra's CSS
// backdrop blur) is not ported: the panels keep their opaque backing on
// every level.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Clearcoat on glass, lamps and the pond (else plain PBR). */
  glossy: boolean;
  /** Rounded-block bevel segments with surface detail on. */
  bevel: number;
  /** Procedural surface texture size in px (wood, stone, leaf, grass, soil, lamp). */
  texture: number;
  /** Rain drops with particles high (particles low uses 40 %). */
  rain: number;
  /** Pollen motes (particles high). */
  motes: number;
  /** Cloud clusters in the sky (surface detail on). */
  clouds: number;
}
export interface Look {
  preset: Preset;
  /** The level's sun shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting (reflections on glass, lamps and the pond). */
  reflections: boolean;
  /** Rounded textured blocks, the sky dome, clouds, pond rim and ripples, flowers and pebbles, two-tier trees. */
  detailed: boolean;
  /** Rain and pollen motes. */
  particles: "off" | "low" | "high";
  /** Swaying tree crowns, drifting clouds and pond ripples. */
  animated: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "animated">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, detailed: false, particles: "off", animated: false },
  balanced: { reflections: true, detailed: true, particles: "low", animated: true },
  high: { reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { glossy: false, bevel: 1, texture: 64, rain: 600, motes: 0, clouds: 3 },
  balanced: { glossy: false, bevel: 2, texture: 128, rain: 1000, motes: 30, clouds: 5 },
  high: { glossy: true, bevel: 2, texture: 128, rain: 1600, motes: 60, clouds: 7 },
  ultra: { glossy: true, bevel: 4, texture: 256, rain: 3200, motes: 120, clouds: 10 },
};
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  // Rain and motes grow with the level's particle budget above the tier's
  // anchor, at most twice the tier's budget.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize), rain: Math.round(b.rain * k), motes: Math.round(b.motes * k) },
  };
}
