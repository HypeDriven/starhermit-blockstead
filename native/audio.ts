// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, the event table of sfx/manifest.txt) on the runtime's
// mixer with the seeded pitch variants, the valley ambience (wind over the
// meadow that rises with the weather, sparse bird chirps in fair weather)
// and the slow generative pad walking C–Am–F–G every 5.6 s. Every event also
// emits a caption (onCaption).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu tick → "interface". The old default bus
// levels (music 55 %, effects 90 %, ambience 50 %) are folded into each
// sound's gain.
//
// The browser build made the wind, the chirps and the pad with Web Audio
// nodes; here they are rendered once into clips (createClip) with the same
// shapes — the wind a looped 4 s of lowpassed brown noise, one take for
// fair weather (300 Hz) and one for rain (700 Hz) crossfaded on a weather
// change — and the synthesized stand-ins it played while a sample loaded are
// not ported: the engine's browser runtime drops clip loads and plays while
// a synthesis graph changes (the arrow-exodus port's finding). Clips load
// once the mixer runs (natively at once, in a browser after the first press).
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import type { RngStream } from "./classic.ts";

const LEVEL = { music: 0.55, effects: 0.9, ambience: 0.5 };
const SAMPLES = [
  "ui", "select", "deselect", "gather", "place-wood", "place-stone", "place-glass", "place-plant", "place-lamp", "remove",
  "invalid", "goal", "wave", "win", "lose", "undo", "hint", "star", "weather-rain", "weather-cloud", "round-start",
  "lesson-complete", "pause", "resume",
];
/** Events whose pitch varies ±6 % from the seeded AV stream (replay-consistent takes). */
const VARIANT = new Set(["select", "gather", "place-wood", "place-stone", "place-glass", "place-plant", "place-lamp", "remove", "wave"]);
/** Events with a caption (the browser build's CAPTIONS). */
const CAPTIONED = new Set(SAMPLES.filter((n) => n !== "ui" && n !== "deselect" && n !== "star"));

const clips = new Map<string, AudioClip>();
let onCaption: ((event: string) => void) | null = null;
let avRng: RngStream | null = null;
let wantClips = false;

function load(name: string): void {
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
export function setOnCaption(cb: (event: string) => void): void { onCaption = cb; }
export function setAvRng(rng: RngStream): void { avRng = rng; }

/** Plays an event's clip and emits its caption. */
export function play(name: string): void {
  if (CAPTIONED.has(name) && onCaption) onCaption(name);
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = name === "ui" ? "interface" : "effects";
  const pitch = VARIANT.has(name) ? 0.94 + (avRng ? avRng.next() : Math.random()) * 0.12 : 1;
  try { playClip(clip, { bus, gain: LEVEL.effects, pitch }); }
  catch { clips.delete(name); load(name); } // a clip the mixer lost: load it again
}

// -- rendered beds ------------------------------------------------------------------------
const RATE = 11025;
/** RBJ biquad lowpass over `x` in place (Web Audio's BiquadFilterNode, Q ≈ 0.707). */
function lowpass(x: Float32Array, freq: number, rate = RATE, q = Math.SQRT1_2): void {
  const w = (2 * Math.PI * freq) / rate, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}
/** The valley wind: brown noise (the browser build's 0.02-leak walk, ×3.5)
 * lowpassed at `cutoff`, 4 s with the ends crossfaded so the loop is seamless. */
function windClip(cutoff: number, seed: number): AudioClip {
  const n = 4 * RATE, fadeN = Math.round(0.25 * RATE);
  const raw = new Float32Array(n + fadeN);
  let last = 0, s = seed >>> 0;
  for (let i = 0; i < raw.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const w = (s / 4294967296) * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    raw[i] = last * 3.5;
  }
  lowpass(raw, cutoff);
  const out = raw.slice(0, n);
  for (let i = 0; i < fadeN; i++) {
    const k = i / fadeN;
    out[i] = raw[n + i]! * (1 - k) + raw[i]! * k;
  }
  return createClip([out], RATE);
}
/** A bird phrase: `notes` sine chirps 90 ms long, 120 ms apart, each sweeping
 * up by 30 % (the browser build's blip with an exponential sweep). */
function chirpClip(base: number, notes: number): AudioClip {
  const rate = RATE * 4, len = Math.round((0.12 * (notes - 1) + 0.15) * rate);
  const out = new Float32Array(len);
  for (let k = 0; k < notes; k++) {
    const f0 = base * (0.9 + ((k * 37) % 20) / 100), f1 = f0 * 1.3, t0 = k * 0.12, dur = 0.09;
    let ph = 0;
    for (let i = Math.round(t0 * rate); i < Math.min(len, Math.round((t0 + dur + 0.05) * rate)); i++) {
      const t = i / rate - t0;
      const f = f0 * Math.pow(f1 / f0, Math.min(1, t / dur));
      ph += f / rate;
      const env = t < 0.008 ? 0.045 * (t / 0.008) : 0.045 * Math.pow(0.0001 / 0.045, Math.min(1, (t - 0.008) / (dur - 0.008)));
      out[i]! += Math.sin(2 * Math.PI * ph) * env;
    }
  }
  return createClip([out], rate);
}
const CHORDS = [
  [261.63, 329.63, 392.0], // C E G
  [220.0, 261.63, 329.63], // A C E
  [174.61, 220.0, 261.63], // F A C
  [196.0, 246.94, 293.66], // G B D
];
/** One pad chord: a triangle root and two sines an octave down, lowpassed at
 * 650 Hz, rising to 0.045 over 2 s and falling to silence by 6.8 s. */
function chordClip(chord: number[]): AudioClip {
  const n = Math.round(7 * RATE);
  const out = new Float32Array(n);
  chord.forEach((freq, v) => {
    const f = freq * 0.5;
    const voice = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ph = (f * i / RATE) % 1;
      voice[i] = v === 0 ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(2 * Math.PI * ph);
    }
    lowpass(voice, 650);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const env = t < 2 ? 0.045 * (t / 2) : t < 6.8 ? 0.045 + (0.0001 - 0.045) * ((t - 2) / 4.8) : 0;
      out[i]! += voice[i]! * env;
    }
  });
  return createClip([out], RATE);
}

type Weather = "sun" | "cloud" | "rain";
const WIND_GAIN: Record<Weather, number> = { sun: 0.3, cloud: 0.4, rain: 0.55 };
let started = false;
let paused = false;
let weather: Weather = "sun";
let calm: Sound | null = null, storm: Sound | null = null;
let calmClip: AudioClip | null = null, stormClip: AudioClip | null = null;
const chords: AudioClip[] = [];
const chirps: AudioClip[] = [];
let chordIdx = 0;
let nextChord = 0;
let nextBird = 0;

/** The beds start with the first round (the browser build's BSAudio.start). */
export function start(): void { started = true; }
function windGains(): [number, number] {
  if (paused) return [0, 0];
  const g = WIND_GAIN[weather] * LEVEL.ambience;
  return weather === "rain" ? [0, g] : [g, 0];
}
function fadeWind(seconds: number): void {
  const [a, b] = windGains();
  try { calm?.fade(a, seconds); } catch { calm = null; }
  try { storm?.fade(b, seconds); } catch { storm = null; }
}
/** Pause: the beds fall silent (the browser build suspended its context). */
export function setPaused(on: boolean): void {
  paused = on;
  fadeWind(0.3);
}
/** The seeded weather (cosmetic): the wind swells for cloud and rain. */
export function setWeather(w: Weather): void {
  if (w === weather) return;
  weather = w;
  fadeWind(1.2);
}

/** Each frame: what waited for the mixer, one rendered clip a frame, then
 * the pad's next chord every 5.6 s and a bird phrase every 3–10 s of mixer
 * time in fair weather. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of SAMPLES) load(name);
    return;
  }
  if (!started) return;
  try {
    if (!calmClip) { calmClip = windClip(300, 0x51ed); return; }
    if (!stormClip) { stormClip = windClip(700, 0x2a7b); return; }
    if (chords.length < CHORDS.length) { chords.push(chordClip(CHORDS[chords.length]!)); return; }
    if (chirps.length < 3) { chirps.push(chirpClip(1800 + chirps.length * 500, 2 + chirps.length)); return; }
    if (!calm || !storm) {
      const [a, b] = windGains();
      calm = playClip(calmClip, { bus: "effects", gain: a, loop: true });
      storm = playClip(stormClip, { bus: "effects", gain: b, loop: true });
      return;
    }
  } catch (e) { console.warn(`beds: ${String(e)}`); started = false; return; }
  if (paused) return;
  const now = context.currentTime;
  if (now >= nextChord) {
    nextChord = now + 5.6;
    try { playClip(chords[chordIdx++ % chords.length]!, { bus: "music", gain: LEVEL.music }); } catch { /* the mixer is full */ }
  }
  if (now >= nextBird) {
    const first = nextBird === 0;
    nextBird = now + 3 + Math.random() * 7;
    if (!first && weather !== "rain") {
      try { playClip(chirps[Math.floor(Math.random() * chirps.length)]!, { bus: "effects", gain: LEVEL.ambience, pitch: 0.9 + Math.random() * 0.6 }); } catch { /* full */ }
    }
  }
}
