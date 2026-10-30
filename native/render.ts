// The sunny voxel valley on starhermit:scene, ported from the browser build's
// three.js layer (js/render.js before the port): the plot tiles on a soil
// base, the block columns (rounded and textured with surface detail on, plant
// and lamp tops), the seeded decor (valley floor, pond with rim and ripples,
// low-poly trees, wildflowers, pebbles, distant hills), the sky dome and
// drifting clouds, rain and pollen motes, the weather mood, the target discs,
// the ghost block and its ring, the placement pop, the orbiting camera spring
// with its intro swoop and the title's turning showcase homestead, and the
// look per graphics level from quality.ts. It consumes rules snapshots and
// never mutates rules state.
//
// What changed from three.js, and why:
// - The camera fits the plot inside the screen rectangle the HUD leaves
//   (screens.ts passes it) and setViewOffset centres the plot in it, where
//   the browser build measured the DOM panels and shrank the fit around the
//   window's centre.
// - Picking: a ray cast onto each column's box (the tile up to the top
//   block), nearest first, where the browser build cast onto the tile layer.
// - The EffectComposer chain (GTAO, UnrealBloom, OutputPass, the grade
//   ShaderPass, SMAA / FXAA / MSAA) is renderer.ao / bloom / grade /
//   antialias; the grade's GLSL is the built-in display-space grade with the
//   same curve, tints and vignette.
// - The sky dome's GLSL ShaderMaterial is WGSL; IcosahedronGeometry clouds
//   and DodecahedronGeometry pebbles are low-segment spheres;
//   RoundedBoxGeometry is rounded.ts.
// - Light intensities, shadow values and the PMREM RoomEnvironment(renderer)
//   are three.js r160's as the page had them (engine minor 28), with the
//   sun's shadow box fitted around the plot (fitShadow). The block materials
//   get the room as their own envMap so their envMapIntensity applies as
//   r160 did with scene.environment. The procedural surface textures are DataTextures of the
//   same grey patterns (sRGB, as the browser build's CanvasTextures were).
import {
  ACESFilmicToneMapping, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry,
  CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera, PCFSoftShadowMap, PMREMGenerator, PerspectiveCamera, Points, PointsMaterial,
  Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, ShaderMaterial, SphereGeometry, TorusGeometry,
  Vector3, pointerToNdc, renderer, scene,
} from "starhermit:scene";
import type { Material, Object3D, Texture } from "starhermit:scene";
import type { Block, Palette, RulesEvent, State } from "./classic.ts";
import type { Budget, Look } from "./quality.ts";
import { roundedBox } from "./rounded.ts";

const PI = Math.PI;
const CELL = 1;
const FRAMING = { phi: 0.95, theta: 0.65 };
const LOOK_AT = new Vector3(0, 0.8, 0);

const camera = new PerspectiveCamera(38, 16 / 9, 0.1, 200);
let look: Look | null = null;
let BUD: Budget = { glossy: true, bevel: 2, texture: 128, rain: 1000, motes: 30, clouds: 5, bloomRes: 0.5 };
let reducedMotion = false;
let highVis = false;
let built = false;

// --- lights ---------------------------------------------------------------------------
const hemi = new HemisphereLight(0xcfe8ff, 0x6a7a55, 0.7);
const SUN_DIR = new Vector3(8, 14, 6).normalize();
const sun = new DirectionalLight(0xfff2cc, 2.4);
sun.position.copy(SUN_DIR).multiplyScalar(20);
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
/** Shadow box fitted tightly around the plot (blocks included), as the browser build's. */
function fitShadow(): void {
  const half = Math.hypot(Math.max(plotW, 4), Math.max(plotH, 4)) / 2 + 0.9;
  const sc = sun.shadow.camera as OrthographicCamera;
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
  sc.near = Math.max(0.5, 20 - half - 6); sc.far = 20 + half + 4;
  sc.updateProjectionMatrix();
}
let hemiBase = 0.7;

// --- procedural surface textures (grey, multiplied by the material colour) ---------------
function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 2147483647, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
type TexKind = "wood" | "stone" | "leaf" | "grass" | "soil" | "lamp";
function makeTexture(kind: TexKind, size: number): Texture {
  const N = size;
  const S = N / 128; // patterns are authored at 128 px
  const px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const X = Math.floor(x / S), Y = Math.floor(y / S);
    const n = hash2(x, y, 7), n2 = hash2(X >> 2, Y >> 2, 3);
    let v = 0.93;
    if (kind === "wood") {
      const plank = Math.floor(Y / 32);
      const grain = Math.sin((x / S + plank * 17) * 0.45 + Math.sin(y / S * 0.15 + plank) * 2.2) * 0.04;
      v = 0.9 + grain + (n - 0.5) * 0.05 + (hash2(plank, 0, 5) - 0.5) * 0.08;
      if (Y % 32 < 2) v = 0.66; // plank seam
      if ((X === 8 || X === 119) && Y % 32 === 16) v = 0.55; // nail
    } else if (kind === "stone") {
      const row = Math.floor(Y / 32), off = (row % 2) * 32;
      const bx = Math.floor((X + off) / 64);
      v = 0.9 + (hash2(bx, row, 9) - 0.5) * 0.12 + (n2 - 0.5) * 0.08 + (n - 0.5) * 0.05;
      if (Y % 32 < 3 || (X + off) % 64 < 3) v = 0.62; // mortar
    } else if (kind === "leaf") {
      v = 0.86 + (n2 - 0.5) * 0.22 + (n - 0.5) * 0.08;
    } else if (kind === "grass") {
      v = 0.93 + (n2 - 0.5) * 0.06 + (n - 0.5) * 0.07;
      if (n > 0.97) v = 1.0;
    } else if (kind === "soil") {
      v = 0.92 + (n2 - 0.5) * 0.06 + (n - 0.5) * 0.05 + (n > 0.95 ? 0.07 : 0);
    } else {
      const e = Math.min(X, Y, 127 - X, 127 - Y);
      v = e < 12 ? 0.42 : (X > 60 && X < 68) || (Y > 60 && Y < 68) ? 0.5 : 1;
    }
    const b = Math.max(0, Math.min(255, Math.round(v * 255)));
    const i = (y * N + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = b; px[i + 3] = 255;
  }
  const t = new DataTexture(px, N, N);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
const texCache = new Map<string, Texture>();
function texture(kind: TexKind | "ground"): Texture {
  const id = `${kind}:${BUD.texture}`;
  let t = texCache.get(id);
  if (!t) {
    t = makeTexture(kind === "ground" ? "grass" : kind, BUD.texture);
    if (kind === "ground") t.repeat.set(10, 10);
    texCache.set(id, t);
  }
  return t;
}

// --- materials (created once and updated in place) ---------------------------------------
const mats = {
  wood: new MeshStandardMaterial({ roughness: 0.78 }),
  stone: new MeshStandardMaterial({ roughness: 0.88 }),
  glass: new MeshPhysicalMaterial({ roughness: 0.12, metalness: 0, transparent: true, opacity: 0.7, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
  plant: new MeshStandardMaterial({ roughness: 0.8 }),
  plantTop: new MeshStandardMaterial({ roughness: 0.75 }),
  lamp: new MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
  rock: new MeshStandardMaterial({ color: 0x6b6560, roughness: 1 }),
  tile: new MeshStandardMaterial({ roughness: 0.92 }),
  tileRock: new MeshStandardMaterial({ color: 0x7a746c, roughness: 1 }),
  soil: new MeshStandardMaterial({ roughness: 1 }),
  ground: new MeshStandardMaterial({ roughness: 1 }),
  water: new MeshPhysicalMaterial({ roughness: 0.22, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.15 }),
  trunk: new MeshStandardMaterial({ color: 0x7a5638, roughness: 1 }),
  crown: new MeshStandardMaterial({ roughness: 0.9 }),
  hill: new MeshStandardMaterial({ roughness: 1 }),
  cloud: new MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  flower: new MeshStandardMaterial({ roughness: 0.95 }),
  markerOk: new MeshBasicMaterial({ color: 0x7cfc9a, transparent: true, opacity: 0.9, side: DoubleSide }),
  markerHover: new MeshBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.95, side: DoubleSide }),
  markerBad: new MeshBasicMaterial({ color: 0xff6a5e, transparent: true, opacity: 0.9, side: DoubleSide }),
};
type LitKey = "wood" | "stone" | "glass" | "plant" | "plantTop" | "lamp" | "rock" | "tile" | "tileRock" | "soil" | "ground" | "water" | "trunk" | "crown" | "hill" | "cloud" | "flower";
const LIT: LitKey[] = ["wood", "stone", "glass", "plant", "plantTop", "lamp", "rock", "tile", "tileRock", "soil", "ground", "water", "trunk", "crown", "hill", "cloud", "flower"];
const BLOCK_COLORS = {
  standard: { wood: 0xb07a45, stone: 0x8d9299, glass: 0x9fd8e8, plant: 0x6fbf5a, lamp: 0xffd27a },
  "high-visibility": { wood: 0xb7791f, stone: 0x9aa0a8, glass: 0x4cc9f0, plant: 0x2f9e44, lamp: 0xffd60a },
};
let palette: Palette = { sky: 0x87bfe8, horizon: 0xd8ecdc, ground: 0x77a95c, soil: 0x8a6a48, sun: 0xfff2cc, sunInt: 1.25, fog: 0xbcd8e8, water: 0x5f9fc8, leaf: 0x4f8f3f };
type Weather = "sun" | "cloud" | "rain";
let weather: Weather = "sun";

/** The block colours in the current palette (the tray's swatches use them too). */
export function blockColor(b: Block, hv: boolean): number {
  if (b === "rock") return 0x6b6560;
  return BLOCK_COLORS[hv ? "high-visibility" : "standard"][b];
}

function updateMats(): void {
  const c = BLOCK_COLORS[highVis ? "high-visibility" : "standard"];
  const detailed = !!look?.detailed && !highVis;
  const map = (m: MeshStandardMaterial, kind: TexKind | "ground"): void => { m.map = detailed ? texture(kind) : null; };
  mats.wood.color.set(c.wood); map(mats.wood, "wood");
  mats.stone.color.set(c.stone); map(mats.stone, "stone");
  mats.glass.color.set(c.glass);
  mats.plant.color.set(c.plant); map(mats.plant, "leaf");
  mats.plantTop.color.set(palette.leaf); map(mats.plantTop, "leaf");
  mats.lamp.color.set(c.lamp); mats.lamp.emissive.set(c.lamp);
  mats.lamp.emissiveIntensity = 2.2; map(mats.lamp, "lamp");
  mats.lamp.emissiveMap = mats.lamp.map;
  mats.tile.color.set(palette.ground); map(mats.tile, "grass");
  map(mats.tileRock, "stone");
  mats.soil.color.set(palette.soil); map(mats.soil, "soil");
  mats.ground.color.set(palette.ground); map(mats.ground, "ground");
  mats.water.color.set(palette.water).multiplyScalar(0.8);
  mats.crown.color.set(palette.leaf);
  mats.hill.color.set(palette.horizon);
  // Clearcoat only where the budget allows it.
  const gl = BUD.glossy;
  mats.glass.clearcoat = gl ? 0.8 : 0; mats.lamp.clearcoat = gl ? 0.6 : 0; mats.water.clearcoat = gl ? 0.3 : 0;
  for (const k of LIT) mats[k].envMapIntensity = 0.35;
  mats.glass.envMapIntensity = 0.6; mats.water.envMapIntensity = 0.45; mats.lamp.envMapIntensity = 0.5;
  // r160 scaled scene.environment by these; the engine (as three r163+) only scales a material's own envMap.
  const env = look?.reflections ? envTex : null;
  for (const m of Object.values(mats)) if (m instanceof MeshStandardMaterial) m.envMap = env;
}

// --- shared geometry ---------------------------------------------------------------------
const boxGeo = new BoxGeometry(0.92, 0.92, 0.92);
const tileGeo = new BoxGeometry(0.98, 0.12, 0.98);
const topGeo = new BoxGeometry(0.5, 0.28, 0.5);
const ringGeo = new RingGeometry(0.3, 0.42, 24);
const discGeo = new CircleGeometry(0.16, 16);
const roundGeos = new Map<string, BufferGeometry>();
function roundBlock(segs: number, top: boolean): BufferGeometry {
  const k = (top ? "t" : "b") + segs;
  let g = roundGeos.get(k);
  if (!g) {
    g = top ? roundedBox(0.5, 0.28, 0.5, segs, 0.05) : roundedBox(0.92, 0.92, 0.92, segs, 0.07);
    roundGeos.set(k, g);
  }
  return g;
}
const SHARED = new Set<BufferGeometry>([boxGeo, tileGeo, topGeo, ringGeo, discGeo]);
function disposeGroup(g: Object3D): void {
  g.traverse((o) => {
    if (o instanceof Mesh || o instanceof InstancedMesh) {
      const geo = o.geometry as BufferGeometry;
      if (!SHARED.has(geo) && ![...roundGeos.values()].includes(geo)) geo.dispose();
    }
  });
}

// --- groups --------------------------------------------------------------------------------
const envGroup = new Group();
const gameGroup = new Group();
const selectGroup = new Group();
const fxGroup = new Group();

// --- plot state ----------------------------------------------------------------------------
interface View { plot: { cols: number; rows: number; maxH: number }; grid: Block[][][]; seed: number }
let view: View | null = null;
let blockMeshes: Group[] = [];
let tiles: Mesh[] = [];
let plotW = 0, plotH = 0, maxH = 3;
let decorSeed = -1;
let showcase = false;
let decorGroup: Group | null = null;
let crowns: Group[] = [];
let ripples: Mesh[] = [];
let clouds: Group | null = null;
let sky: Mesh | null = null;

function cellOrigin(): { x: number; z: number } {
  return { x: -((plotW - 1) * CELL) / 2, z: -((plotH - 1) * CELL) / 2 };
}
function cellPos(x: number, y: number, h: number, out = new Vector3()): Vector3 {
  const o = cellOrigin();
  return out.set(o.x + x * CELL, 0.06 + (h + 0.5) * 0.92, o.z + y * CELL);
}

function makeBlockMesh(type: Block, x: number, y: number, h: number): Group {
  const detailed = !!look?.detailed;
  const g = new Group();
  const segs = Math.max(1, BUD.bevel);
  const m = new Mesh(detailed ? roundBlock(segs, false) : boxGeo, mats[type] ?? mats.stone);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  if (type === "plant") {
    const top = new Mesh(detailed ? roundBlock(segs, true) : topGeo, mats.plantTop);
    top.position.y = 0.55; top.castShadow = true;
    g.add(top);
  } else if (type === "lamp") {
    const cap = new Mesh(detailed ? roundBlock(segs, true) : topGeo, mats.rock);
    cap.position.y = 0.55; cap.castShadow = true;
    g.add(cap);
  } else if (type === "rock") {
    m.scale.set(1 + ((x * 7 + y * 13 + h * 5) % 3) * 0.05, 0.9, 1);
    m.rotation.y = ((x * 31 + y * 17 + h * 11) % 8) * 0.06;
  }
  cellPos(x, y, h, g.position);
  g.userData = { x, y, h, type };
  return g;
}

// --- environment (seeded decor) ----------------------------------------------------------------
function buildDecor(seed: number): void {
  if (decorGroup) { envGroup.remove(decorGroup); disposeGroup(decorGroup); }
  decorGroup = new Group();
  crowns = []; ripples = [];
  const detailed = !!look?.detailed;
  let s = (seed ^ 0x85ebca6b) >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ground = new Mesh(new CylinderGeometry(16, 18, 1.2, detailed ? 48 : 28), mats.ground);
  ground.position.y = -0.75; ground.receiveShadow = true;
  decorGroup.add(ground);
  const soil = new Mesh(new BoxGeometry(plotW + 1.2, 0.5, plotH + 1.2), mats.soil);
  soil.position.y = -0.28; soil.receiveShadow = true;
  decorGroup.add(soil);
  const pondPos = new Vector3(plotW * 0.9 + 2.5, -0.12, plotH * 0.5);
  const pond = new Mesh(new CircleGeometry(2.2, 32), mats.water);
  pond.rotation.x = -PI / 2;
  pond.position.copy(pondPos);
  pond.receiveShadow = true;
  decorGroup.add(pond);
  if (detailed) {
    const rim = new Mesh(new TorusGeometry(2.25, 0.16, 6, 32), mats.rock);
    rim.rotation.x = -PI / 2; rim.position.copy(pondPos); rim.position.y = -0.1;
    decorGroup.add(rim);
    for (let i = 0; i < 3; i++) {
      const r = new Mesh(new RingGeometry(0.9, 0.96, 32), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      r.rotation.x = -PI / 2; r.position.copy(pondPos); r.position.y = -0.1;
      r.position.x += (rnd() - 0.5) * 1.6; r.position.z += (rnd() - 0.5) * 1.6;
      r.userData.phase = i / 3;
      r.noAO = true;
      ripples.push(r); decorGroup.add(r);
    }
  }
  const trunkGeo = new CylinderGeometry(0.12, 0.18, 0.9, 6);
  const crownGeo = new ConeGeometry(0.65, 1.4, 7);
  const crownGeo2 = new ConeGeometry(0.5, 1.0, 7);
  const nTrees = detailed ? 14 : 5;
  const castTrees = !!look && look.shadows > 0;
  for (let i = 0; i < nTrees; i++) {
    const a = rnd() * PI * 2;
    const r = 6.5 + rnd() * 6;
    const t = new Group();
    const trunk = new Mesh(trunkGeo, mats.trunk);
    trunk.position.y = 0.4; trunk.castShadow = castTrees;
    const crown = new Group();
    const c1 = new Mesh(crownGeo, mats.crown);
    c1.position.y = 0.6; c1.castShadow = castTrees;
    crown.add(c1);
    if (detailed) {
      const c2 = new Mesh(crownGeo2, mats.crown);
      c2.position.y = 1.25; c2.castShadow = castTrees;
      crown.add(c2);
    }
    crown.position.y = 0.9;
    crown.userData.phase = rnd() * PI * 2;
    crowns.push(crown);
    t.add(trunk, crown);
    t.scale.setScalar(0.8 + rnd() * 0.7);
    t.position.set(Math.cos(a) * r, -0.2, Math.sin(a) * r);
    decorGroup.add(t);
  }
  if (detailed) {
    // wildflowers (one instanced draw) and pebbles scattered around the plot
    const nF = 90;
    const flowers = new InstancedMesh(new BoxGeometry(0.12, 0.12, 0.12), mats.flower, nF);
    const m4 = new Matrix4(), col = new Color();
    const FLOWER = [0xd9b93a, 0xd0607a, 0x8a6fd0, 0xe08a3a, 0xc9c0e8];
    const clearX = plotW / 2 + 1.2, clearZ = plotH / 2 + 1.2;
    for (let i = 0; i < nF; i++) {
      let x: number, z: number;
      do { x = (rnd() - 0.5) * 22; z = (rnd() - 0.5) * 22; }
      while ((Math.abs(x) < clearX && Math.abs(z) < clearZ) || Math.hypot(x - pondPos.x, z - pondPos.z) < 2.6 || Math.hypot(x, z) > 14.5);
      m4.makeScale(1, 0.6, 1).setPosition(x, -0.12, z);
      flowers.setMatrixAt(i, m4);
      flowers.setColorAt(i, col.setHex(FLOWER[i % FLOWER.length]!));
    }
    decorGroup.add(flowers);
    for (let i = 0; i < 10; i++) {
      let x: number, z: number;
      do { x = (rnd() - 0.5) * 20; z = (rnd() - 0.5) * 20; }
      while ((Math.abs(x) < clearX && Math.abs(z) < clearZ) || Math.hypot(x - pondPos.x, z - pondPos.z) < 2.6);
      const p = new Mesh(new SphereGeometry(0.18 + rnd() * 0.22, 5, 3), mats.rock);
      p.position.set(x, -0.1, z); p.rotation.set(rnd() * 3, rnd() * 3, 0);
      p.castShadow = castTrees; p.receiveShadow = true;
      decorGroup.add(p);
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2 + rnd();
    const hill = new Mesh(new ConeGeometry(4 + rnd() * 3, 3 + rnd() * 2, 7), mats.hill);
    hill.position.set(Math.cos(a) * 22, -0.5, Math.sin(a) * 22);
    decorGroup.add(hill);
  }
  envGroup.add(decorGroup);
  fitShadow();
}

// --- the sky dome (WGSL port of the browser build's sky gradient) and clouds -------------------
const skyUniforms = {
  uTop: { value: new Color() }, uHorizon: { value: new Color() },
  uSunDir: { value: SUN_DIR.clone() }, uSun: { value: new Color() },
};
const SKY_FRAGMENT = `
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world);
  let h = clamp(d.y, -0.2, 1.0);
  var c = mix(uniforms.uHorizon, uniforms.uTop, smoothstep(-0.02, 0.55, h));
  let g = max(dot(d, normalize(uniforms.uSunDir)), 0.0);
  c = c + uniforms.uSun * (pow(g, 24.0) * 0.35 + pow(g, 400.0) * 0.8);
  return vec4f(c, 1.0);
}`;
function buildSky(): void {
  if (sky) { envGroup.remove(sky); sky.geometry.dispose(); sky.material.dispose(); sky = null; }
  if (clouds) { envGroup.remove(clouds); disposeGroup(clouds); clouds = null; }
  if (!look?.detailed) return;
  sky = new Mesh(new SphereGeometry(90, 32, 16), new ShaderMaterial({
    uniforms: skyUniforms, fragmentShader: SKY_FRAGMENT, side: BackSide, depthWrite: false, fog: false,
  }));
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.noAO = true;
  envGroup.add(sky);
  clouds = new Group();
  const puff = new SphereGeometry(1, 8, 6);
  const n = BUD.clouds;
  for (let i = 0; i < n; i++) {
    const c = new Group();
    const k0 = 3 + (i % 3);
    for (let k = 0; k < k0; k++) {
      const p = new Mesh(puff, mats.cloud);
      p.position.set((k - k0 / 2) * 1.3, Math.sin(k * 2.1 + i) * 0.3, Math.cos(k * 1.7 + i) * 0.6);
      p.scale.setScalar(1.1 + ((k + i) % 3) * 0.35);
      p.noAO = true;
      c.add(p);
    }
    const a = (i / n) * PI * 2 + 0.4;
    c.position.set(Math.cos(a) * 26, 12 + (i % 3) * 2, Math.sin(a) * 26);
    c.scale.set(1.4, 0.7, 1);
    c.lookAt(0, c.position.y, 0);
    clouds.add(c);
  }
  envGroup.add(clouds);
}

// --- weather and ambient particles ---------------------------------------------------------------
let rain: Points | null = null, rainVel: Float32Array | null = null, motes: Points | null = null;
let rainMat: PointsMaterial | null = null;
function buildParticles(): void {
  if (rain) { fxGroup.remove(rain); rain.geometry.dispose(); rain.material.dispose(); rain = null; rainMat = null; }
  if (motes) { fxGroup.remove(motes); motes.geometry.dispose(); motes.material.dispose(); motes = null; }
  const p = look?.particles ?? "off";
  const n = p === "high" ? BUD.rain : p === "low" ? Math.round(BUD.rain * 0.4) : 0;
  if (!n) return;
  const pos = new Float32Array(n * 3);
  rainVel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 24;
    pos[i * 3 + 1] = Math.random() * 12;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 24;
    rainVel[i] = 6 + Math.random() * 4;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  rainMat = new PointsMaterial({ color: 0xbfd8ee, size: 0.07, transparent: true, opacity: 0, depthWrite: false });
  rain = new Points(geo, rainMat);
  rain.frustumCulled = false;
  fxGroup.add(rain);
  if (p === "high" && BUD.motes > 0) {
    const m = BUD.motes, mp = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      mp[i * 3] = (Math.random() - 0.5) * 14; mp[i * 3 + 1] = 0.3 + Math.random() * 4; mp[i * 3 + 2] = (Math.random() - 0.5) * 14;
    }
    const mg = new BufferGeometry();
    mg.setAttribute("position", new BufferAttribute(mp, 3));
    motes = new Points(mg, new PointsMaterial({ color: 0xfff4c8, size: 0.035, transparent: true, opacity: 0.4, depthWrite: false }));
    motes.frustumCulled = false;
    fxGroup.add(motes);
  }
}

function applyAtmosphere(): void {
  const dim = weather === "rain" ? 0.45 : weather === "cloud" ? 0.7 : 1;
  sun.intensity = 2.4 * palette.sunInt * dim;
  sun.color.set(palette.sun);
  hemi.intensity = hemiBase * (weather === "rain" ? 0.7 : 1);
  const fogC = new Color(palette.fog).multiplyScalar(weather === "sun" ? 1 : 0.85);
  scene.fog = new Fog(fogC, 26, 60);
  const bg = new Color(palette.sky).lerp(fogC, weather === "sun" ? 0.15 : 0.55);
  scene.background = bg;
  skyUniforms.uTop.value.copy(bg);
  skyUniforms.uHorizon.value.copy(fogC);
  skyUniforms.uSun.value.set(palette.sun).multiplyScalar(weather === "sun" ? 1 : 0.15);
  mats.cloud.color.setHex(weather === "rain" ? 0x9aa4ae : weather === "cloud" ? 0xd8dee4 : 0xffffff);
  if (rainMat) rainMat.opacity = weather === "rain" ? 0.55 : 0;
  if (motes) motes.visible = weather === "sun";
}

// --- selection / ghost ---------------------------------------------------------------------
const marker = new Mesh(ringGeo, mats.markerHover);
marker.rotation.x = -PI / 2;
marker.visible = false;
marker.noAO = true;
const ghostMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
const ghostMesh = new Mesh(boxGeo, ghostMat);
ghostMesh.visible = false;
ghostMesh.noAO = true;
const targetDiscs: Mesh[] = [];

/** Glowing discs on the legal target columns (h = the column's height). */
export function highlightTargets(cells: { x: number; y: number; h: number }[], block: Block | null): void {
  for (const d of targetDiscs) selectGroup.remove(d);
  targetDiscs.length = 0;
  const o = cellOrigin();
  for (const c of cells) {
    const d = new Mesh(discGeo, mats.markerOk);
    d.rotation.x = -PI / 2;
    d.position.set(o.x + c.x * CELL, 0.13 + c.h * 0.92, o.z + c.y * CELL);
    d.noAO = true;
    targetDiscs.push(d);
    selectGroup.add(d);
  }
  ghostMat.color.setHex(block ? 0x9fff9f : 0xffffff);
}
/** The ghost block at a column's next height (green legal, red not), or none. */
export function ghost(x: number | null, y = 0, h = 0, valid = true): void {
  if (x == null) { ghostMesh.visible = false; marker.visible = false; return; }
  ghostMesh.visible = true;
  cellPos(x, y, h, ghostMesh.position);
  ghostMat.color.setHex(valid ? 0x9fff9f : 0xff8a7a);
  marker.visible = true;
  marker.material = valid ? mats.markerHover : mats.markerBad;
  const o = cellOrigin();
  marker.position.set(o.x + x * CELL, 0.14, o.z + y * CELL);
}

// --- camera (spring, interruptible) ---------------------------------------------------------------
const camTarget = { theta: FRAMING.theta, phi: FRAMING.phi, dist: 11 };
const camCur = { theta: FRAMING.theta, phi: FRAMING.phi, dist: 11 };
/** The window rectangle the HUD leaves the plot, as fractions (0–1, y down). */
let free = { l: 0, t: 0, r: 1, b: 1 };
let winW = 16, winH = 9;
let introDone = false;

/** Distance at which the whole plot (all columns up to the max height) fits
 * inside the free rectangle at the given orbit angles. */
function fitDistance(theta: number, phi: number): number {
  const freeW = Math.max(0.3, free.r - free.l - 0.04);
  const freeH = Math.max(0.3, free.b - free.t - 0.04);
  const hw = plotW / 2 + 0.6, hd = plotH / 2 + 0.6, top = Math.max(2.5, maxH);
  const tanV = Math.tan((camera.fov * PI) / 180 / 2);
  const tanH = tanV * (winW / Math.max(1, winH));
  const dirCam = new Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(phi), Math.cos(theta) * Math.cos(phi));
  const fwd = dirCam.clone().multiplyScalar(-1);
  const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();
  let need = 0;
  const rel = new Vector3();
  for (const x of [-hw, hw]) for (const z of [-hd, hd]) for (const y of [0, top]) {
    rel.set(x, y, z).sub(LOOK_AT);
    const depth = -rel.dot(fwd);
    const px = Math.abs(rel.dot(right)), py = Math.abs(rel.dot(up));
    need = Math.max(need, px / (tanH * freeW) + depth, py / (tanV * freeH) + depth);
  }
  return Math.max(5, need);
}
export function resetCamera(): void {
  camTarget.theta = FRAMING.theta; camTarget.phi = FRAMING.phi;
  camTarget.dist = fitDistance(FRAMING.theta, FRAMING.phi);
}
export function topDownCamera(): void {
  camTarget.phi = 1.35;
  camTarget.dist = fitDistance(camTarget.theta, 1.35);
}
/** Drag on the board: orbit (θ free, φ clamped). Pixels. */
export function orbit(dx: number, dy: number): void {
  camTarget.theta -= dx * 0.005;
  camTarget.phi = Math.min(1.35, Math.max(0.55, camTarget.phi - dy * 0.004));
}
/** Wheel zoom, bounded to half and twice the fitted distance. */
export function zoom(deltaY: number): void {
  const fit = fitDistance(camTarget.theta, camTarget.phi);
  camTarget.dist = Math.min(fit * 2, Math.max(fit * 0.5, camTarget.dist + deltaY * 0.01));
}
let freeKey = "";
/** The free rectangle (fractions of the window) and the window's size; refits when either changes. */
export function setFreeRect(rect: { l: number; t: number; r: number; b: number }, w: number, h: number): void {
  const key = [rect.l, rect.t, rect.r, rect.b, w, h].map((n) => n.toFixed(3)).join(",");
  if (key === freeKey) return;
  freeKey = key;
  free = rect;
  winW = Math.max(1, w); winH = Math.max(1, h);
  camera.aspect = winW / winH;
  camera.updateProjectionMatrix();
  if (view) camTarget.dist = fitDistance(camTarget.theta, camTarget.phi);
  if (!introDone && view) {
    // the small intro swoop (skipped under reduced motion)
    introDone = true;
    camCur.dist = camTarget.dist + (reducedMotion ? 0 : 6);
  }
}

// --- picking -------------------------------------------------------------------------------------
const _ray = new Raycaster();
/** The plot column under a window pixel: the nearest column box (tile up to its top block) the ray enters. */
export function pick(px: number, py: number): { x: number; y: number } | null {
  if (!view || showcase) return null;
  _ray.setFromCamera(pointerToNdc(px, py), camera);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  const org = cellOrigin();
  let best: { x: number; y: number } | null = null, bestT = Infinity;
  for (let y = 0; y < plotH; y++) for (let x = 0; x < plotW; x++) {
    const cx = org.x + x * CELL, cz = org.z + y * CELL;
    const top = 0.06 + view.grid[y]![x]!.length * 0.92;
    const lo = [cx - 0.49, -0.06, cz - 0.49], hi = [cx + 0.49, Math.max(0.06, top), cz + 0.49];
    let t0 = 0, t1 = Infinity;
    const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z];
    let hit = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(da[a]!) < 1e-9) { if (oa[a]! < lo[a]! || oa[a]! > hi[a]!) { hit = false; break; } continue; }
      let ta = (lo[a]! - oa[a]!) / da[a]!, tb = (hi[a]! - oa[a]!) / da[a]!;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) { hit = false; break; }
    }
    if (hit && t0 < bestT) { bestT = t0; best = { x, y }; }
  }
  return best;
}

// --- state rebuild ---------------------------------------------------------------------------------
let flashes: { x: number; y: number; h: number; t: number }[] = [];
function setup(): void {
  built = true;
  scene.add(hemi, sun, sun.target, envGroup, gameGroup, selectGroup, fxGroup);
  selectGroup.add(marker, ghostMesh);
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
}

/** Shows a plot (a round's state, or the title's showcase homestead). */
export function setState(state: View, opts: { events?: RulesEvent[]; showcase?: boolean; force?: boolean; keepCamera?: boolean } = {}): void {
  if (!built) setup();
  const wasShowcase = showcase;
  showcase = !!opts.showcase;
  const rebuild = !!opts.force || wasShowcase !== showcase || !view || view.plot.cols !== state.plot.cols ||
    view.plot.rows !== state.plot.rows || decorSeed !== state.seed;
  view = state;
  plotW = state.plot.cols; plotH = state.plot.rows; maxH = state.plot.maxH;
  decorSeed = state.seed;
  if (rebuild) {
    for (const t of tiles) gameGroup.remove(t);
    tiles = [];
    const o = cellOrigin();
    for (let y = 0; y < plotH; y++) for (let x = 0; x < plotW; x++) {
      const hasRock = state.grid[y]![x]!.includes("rock");
      const t = new Mesh(tileGeo, hasRock ? mats.tileRock : mats.tile);
      t.position.set(o.x + x * CELL, 0, o.z + y * CELL);
      t.receiveShadow = true;
      tiles.push(t);
      gameGroup.add(t);
    }
    buildDecor(state.seed);
    if (!opts.keepCamera) {
      resetCamera();
      camCur.dist = camTarget.dist;
    }
  }
  for (const g of blockMeshes) gameGroup.remove(g);
  blockMeshes = [];
  for (let y = 0; y < plotH; y++) for (let x = 0; x < plotW; x++) {
    const st = state.grid[y]![x]!;
    for (let h = 0; h < st.length; h++) {
      const g = makeBlockMesh(st[h]!, x, y, h);
      blockMeshes.push(g);
      gameGroup.add(g);
    }
  }
  if (!reducedMotion && opts.events) {
    for (const e of opts.events) {
      if ((e.type === "place" || e.type === "remove") && e.x != null) flashes.push({ x: e.x, y: e.y!, h: e.type === "place" ? (e.h ?? 1) - 1 : (e.h ?? 0), t: 0 });
    }
  }
}
/** The game's state as a plot view. */
export function show(state: State, events?: RulesEvent[], keepCamera = true): void {
  setState({ plot: state.cfg.plot, grid: state.grid, seed: state.seed }, { events: events ?? [], keepCamera });
}
/** The title screen's showcase: a small finished homestead that slowly turns. */
export function showShowcase(): void {
  const B = [".W.S..", "WWGSS.", ".WLPS.", "..PPL.", "S....W", ".G..WW"];
  const T: Record<string, Block[]> = { W: ["wood", "wood"], S: ["stone", "stone", "glass"], G: ["glass"], L: ["stone", "lamp"], P: ["plant"] };
  const grid = B.map((row) => row.split("").map((ch) => (T[ch] ?? []).slice()));
  grid[1]![1]!.push("wood"); grid[2]![1]!.push("glass");
  ghost(null); highlightTargets([], null);
  setState({ plot: { cols: 6, rows: 6, maxH: 3 }, grid, seed: 20240917 }, { showcase: true });
}

export function setPalette(p: Palette, hv: boolean): void {
  const changed = p !== palette || hv !== highVis;
  palette = p;
  highVis = hv;
  if (!look) return;
  updateMats();
  applyAtmosphere();
  renderer.grade = gradeSettings();
  if (changed && view) setState(view, { force: true, keepCamera: true, showcase });
}
export function setWeather(w: Weather): void { weather = w; applyAtmosphere(); }
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
/** Settle every animation now (the S key). */
export function skipAnimations(): void {
  flashes = [];
  camCur.theta = camTarget.theta; camCur.phi = camTarget.phi; camCur.dist = camTarget.dist;
}

// --- graphics level --------------------------------------------------------------------------------
let envTex: Texture | null = null;
function buildEnvironment(): void {
  if (envTex) return;
  try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
  catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
}
function gradeSettings(): typeof renderer.grade {
  // The browser build's grade ShaderPass after OutputPass: a gentle S-curve
  // (0.18 of c²(3−2c)), saturation 1.1, cool shadows / warm highlights, and
  // the 0.2 vignette (none in high visibility).
  return look?.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.1,
    shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.96], split: [0.2, 0.8],
    vignette: { amount: highVis ? 0 : 0.2, inner: 0.4, outer: 0.9 },
  } : null;
}
/** The look for the frame's graphics level; cheap when nothing changed. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  BUD = next.budget;
  if (!built) setup();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = PCFSoftShadowMap;
  sun.castShadow = shadows;
  if (shadows) sun.shadow.mapSize = next.shadows;
  if (next.reflections) {
    buildEnvironment();
    scene.environment = envTex;
    hemiBase = 0.45;
  } else {
    scene.environment = null;
    hemiBase = 0.7;
  }
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.55, distanceExponent: 1.5, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8 },
  };
  // High threshold: only lamps, glints and sunlit glass bloom.
  // The page's r160 UnrealBloomPass at its own strength (bloom model r160).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.4, radius: 0.35, threshold: 0.95, resolution: next.budget.bloomRes } : null;
  renderer.grade = gradeSettings();
  renderer.antialias = next.antialias;
  updateMats();
  const rebuild = !prev || prev.detailed !== next.detailed || (prev.shadows > 0) !== shadows ||
    prev.budget.bevel !== next.budget.bevel || prev.budget.texture !== next.budget.texture || prev.budget.clouds !== next.budget.clouds;
  if (rebuild) {
    buildSky();
    if (view) setState(view, { force: true, keepCamera: true, showcase });
  }
  if (!prev || prev.particles !== next.particles || prev.budget.rain !== next.budget.rain || prev.budget.motes !== next.budget.motes) buildParticles();
  applyAtmosphere();
}

// --- per frame ---------------------------------------------------------------------------------------
let clock = 0;
export function frame(dtRaw: number): void {
  if (!built || !look) return;
  const dt = Math.min(0.05, Math.max(0, dtRaw));
  const moving = !reducedMotion;
  if (moving) clock += dt;
  if (showcase && moving) camTarget.theta += dt * 0.06;
  const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
  camCur.theta += (camTarget.theta - camCur.theta) * k;
  camCur.phi += (camTarget.phi - camCur.phi) * k;
  camCur.dist += (camTarget.dist - camCur.dist) * k;
  const cy = Math.sin(camCur.phi) * camCur.dist, ch = Math.cos(camCur.phi) * camCur.dist;
  camera.position.set(Math.sin(camCur.theta) * ch, cy, Math.cos(camCur.theta) * ch);
  camera.lookAt(LOOK_AT);
  camera.far = Math.max(200, camCur.dist * 4);
  // the plot centred in the free rectangle
  const cx = ((free.l + free.r) / 2) * winW, cyPx = ((free.t + free.b) / 2) * winH;
  camera.setViewOffset(winW, winH, winW / 2 - cx, winH / 2 - cyPx, winW, winH);
  sun.target.position.set(0, 0, 0);
  sun.position.copy(SUN_DIR).multiplyScalar(20);

  // placement pops: a brief scale pop on the affected column top
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]!;
    f.t += dt;
    const m = blockMeshes.find((g) => g.userData.x === f.x && g.userData.y === f.y && g.userData.h === f.h);
    if (m) m.scale.setScalar(f.t < 0.25 ? 1 + Math.max(0, 0.25 * (1 - f.t / 0.25)) : 1);
    if (f.t > 0.3) flashes.splice(i, 1);
  }
  // ambient scenery (animated levels; frozen under reduced motion)
  if (look.animated && moving) {
    const gust = weather === "rain" ? 2.2 : weather === "cloud" ? 1.4 : 1;
    for (const c of crowns) {
      c.rotation.z = Math.sin(clock * 1.3 + (c.userData.phase as number)) * 0.04 * gust;
      c.rotation.x = Math.cos(clock * 1.1 + (c.userData.phase as number)) * 0.03 * gust;
    }
    if (clouds) clouds.rotation.y += dt * 0.012;
    for (const r of ripples) {
      const p = (clock * 0.35 + (r.userData.phase as number)) % 1;
      r.scale.setScalar(0.3 + p * 1.4);
      (r.material as Material).opacity = 0.35 * (1 - p) * (weather === "rain" ? 1.6 : 1);
    }
  } else {
    for (const r of ripples) (r.material as Material).opacity = 0;
  }
  if (rain && rainVel && rainMat && rainMat.opacity > 0.01 && moving) {
    const attr = rain.geometry.getAttribute("position")!;
    const p = attr.array as Float32Array;
    for (let i = 0; i < rainVel.length; i++) {
      p[i * 3 + 1]! -= rainVel[i]! * dt;
      if (p[i * 3 + 1]! < 0) p[i * 3 + 1] = 12;
    }
    attr.needsUpdate = true;
  }
  if (motes && motes.visible && moving) {
    motes.rotation.y += dt * 0.03;
    motes.position.y = Math.sin(clock * 0.4) * 0.25;
  }
}
