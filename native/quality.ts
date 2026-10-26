// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the rain drops and pollen motes scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level (at most 2×). The runtime owns the rest of what the old Graphics
// panel did: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout, and the
// shadow-map size and MSAA samples it holds to the level. The frosted-glass
// HUD (High and Ultra's CSS backdrop blur) is not ported: the panels keep
// their opaque backing on every level.
import type { QualityTier } from "starhermit:engine";
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
  /** Bloom resolution as a fraction of the frame. */
  bloomRes: number;
}
export interface Look {
  preset: Preset;
  /** Sun shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "off", animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low", animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { glossy: false, bevel: 1, texture: 64, rain: 600, motes: 0, clouds: 3, bloomRes: 0.5 },
  balanced: { glossy: false, bevel: 2, texture: 128, rain: 1000, motes: 30, clouds: 5, bloomRes: 0.5 },
  high: { glossy: true, bevel: 2, texture: 128, rain: 1600, motes: 60, clouds: 7, bloomRes: 0.75 },
  ultra: { glossy: true, bevel: 4, texture: 256, rain: 3200, motes: 120, clouds: 10, bloomRes: 1 },
};
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: rain and motes grow with
  // the level above the tier's first, at most twice the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.rain = Math.round(b.rain * k);
  b.motes = Math.round(b.motes * k);
  return { preset, ...TABLE[preset], budget: b };
}
