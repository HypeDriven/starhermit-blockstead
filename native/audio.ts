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
// The wind, the chirps and the pad are rendered once into clips by the engine's
// OfflineAudioContext at start — the wind a looped 4 s of lowpassed brown noise,
// one take for fair weather (300 Hz) and one for rain (700 Hz) crossfaded on a
// weather change. The one-shot clips all load in onStart; the beds start once
// the mixer runs (in a browser after the first press).
import { OfflineAudioContext, SoundBank, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
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

/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of SAMPLES) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  const failed = (what: string) => (e: unknown): void => console.warn(`${what}: ${String(e)}`);
  renderWind(300, 0x51ed).then((c) => { calmClip = c; }, failed("wind"));
  renderWind(700, 0x2a7b).then((c) => { stormClip = c; }, failed("wind"));
  Promise.all(CHORDS.map(renderChord)).then((c) => { chords = c; }, failed("pad"));
  Promise.all([0, 1, 2].map((i) => renderChirp(1800 + i * 500, 2 + i))).then((clips) => {
    chirps = new SoundBank({ clips, bus: "effects", gain: LEVEL.ambience, pitch: 1.2, pitchJitter: 0.25 });
  }, failed("chirps"));
}
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
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered beds ------------------------------------------------------------------------
const RATE = 11025;
/** The valley wind: brown noise lowpassed at `cutoff`, a seamless 4 s loop (the
 * noise repeats every 4 s, so once the filter settled so does its output). */
async function renderWind(cutoff: number, seed: number): Promise<AudioClip> {
  const n = 4 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed, seconds: 4 });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = cutoff;
  noise.connect(lp).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** A bird phrase: `notes` sine chirps 90 ms long, 120 ms apart, each sweeping
 * up by 30 % (the browser build's blip with an exponential sweep). */
async function renderChirp(base: number, notes: number): Promise<AudioClip> {
  const rate = RATE * 4;
  const off = new OfflineAudioContext(1, Math.round((0.12 * (notes - 1) + 0.15) * rate), rate);
  for (let k = 0; k < notes; k++) {
    const f0 = base * (0.9 + ((k * 37) % 20) / 100), t0 = k * 0.12, dur = 0.09;
    const osc = off.createOscillator();
    osc.frequency.setValueAtTime(f0, t0); osc.frequency.exponentialRampToValueAtTime(f0 * 1.3, t0 + dur);
    const g = off.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.045, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(off.destination); osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
  return createClip(await off.startRendering());
}
const CHORDS = [
  [261.63, 329.63, 392.0], // C E G
  [220.0, 261.63, 329.63], // A C E
  [174.61, 220.0, 261.63], // F A C
  [196.0, 246.94, 293.66], // G B D
];
/** One pad chord: a triangle root and two sines an octave down, lowpassed at
 * 650 Hz, rising to 0.045 over 2 s and falling to silence by 6.8 s. */
async function renderChord(chord: number[]): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(7 * RATE), RATE);
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 650;
  const g = off.createGain();
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.045, 2); g.gain.linearRampToValueAtTime(0.0001, 6.8); g.gain.setValueAtTime(0, 6.8);
  lp.connect(g).connect(off.destination);
  chord.forEach((freq, v) => {
    const osc = off.createOscillator(); osc.type = v === 0 ? "triangle" : "sine"; osc.frequency.value = freq * 0.5;
    osc.connect(lp); osc.start();
  });
  return createClip(await off.startRendering());
}

type Weather = "sun" | "cloud" | "rain";
const WIND_GAIN: Record<Weather, number> = { sun: 0.3, cloud: 0.4, rain: 0.55 };
let started = false;
let paused = false;
let weather: Weather = "sun";
let calm: Sound | null = null, storm: Sound | null = null;
let calmClip: AudioClip | null = null, stormClip: AudioClip | null = null;
let chords: AudioClip[] = [];
let chirps: SoundBank | null = null;
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

/** Each frame once the mixer runs and the clips are rendered: the
 * pad's next chord every 5.6 s and a bird phrase every 3–10 s of mixer
 * time in fair weather. */
export function update(): void {
  if (context.state !== "running" || !started) return; // starting the beds still waits for the mixer
  if (!calmClip || !stormClip || !chords.length || !chirps) return;
  try {
    // one new loop a frame (two plays in one frame were occasionally rejected by headless Chrome's mixer)
    if (!calm) { calm = playClip(calmClip, { bus: "effects", gain: windGains()[0], loop: true }); return; }
    if (!storm) { storm = playClip(stormClip, { bus: "effects", gain: windGains()[1], loop: true }); return; }
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
      try { chirps.play(); } catch { /* full */ }
    }
  }
}
