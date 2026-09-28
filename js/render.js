/* Blockstead — Three.js renderer (ES module).
 * Sunny voxel valley with changing weather. The render layer consumes
 * immutable rules snapshots; it never mutates game state. Raycasts run
 * only against the explicit cell-interaction layer; particles and decor
 * never intercept picks. All decorative randomness uses the decor stream.
 * Graphics quality (presets / per-effect overrides) comes from gfx.js and is
 * applied live by setGraphics(); post-processing uses the r160 addons that
 * match the vendored three.js build.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { autoPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

const CELL = 1;                 // world units per plot cell
const FRAMING = { phi: 0.95, theta: 0.65, dist: 11 }; // authored default framing

// Colour grade + vignette, applied after the OutputPass (display space in/out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve contrast, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.2, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`
};

// Vertical sky gradient for the backdrop dome (no fog, never picked).
const SKY_VERT = 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const SKY_FRAG = `
  uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSun;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -0.2, 1.0);
    vec3 c = mix(uHorizon, uTop, smoothstep(-0.02, 0.55, h));
    float g = max(dot(normalize(vDir), uSunDir), 0.0);
    c += uSun * (pow(g, 24.0) * 0.35 + pow(g, 400.0) * 0.8);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// ---------- procedural surface textures (grey, multiplied by material colour) ----------
function hash2(x, y, s) {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 2147483647, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function makeTexture(kind) {
  const N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  const px = (x, y, v) => {
    const i = (y * N + x) * 4;
    const b = Math.max(0, Math.min(255, v * 255));
    img.data[i] = img.data[i + 1] = img.data[i + 2] = b; img.data[i + 3] = 255;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const n = hash2(x, y, 7), n2 = hash2(x >> 2, y >> 2, 3);
    let v = 0.93;
    if (kind === 'wood') {
      const plank = Math.floor(y / 32);
      const grain = Math.sin((x + plank * 17) * 0.45 + Math.sin(y * 0.15 + plank) * 2.2) * 0.04;
      v = 0.9 + grain + (n - 0.5) * 0.05 + (hash2(plank, 0, 5) - 0.5) * 0.08;
      if (y % 32 < 2) v = 0.66;                               // plank seam
      if ((x === 8 || x === 119) && (y % 32 === 16)) v = 0.55; // nail
    } else if (kind === 'stone') {
      const row = Math.floor(y / 32), off = (row % 2) * 32;
      const bx = Math.floor((x + off) / 64);
      v = 0.9 + (hash2(bx, row, 9) - 0.5) * 0.12 + (n2 - 0.5) * 0.08 + (n - 0.5) * 0.05;
      if (y % 32 < 3 || (x + off) % 64 < 3) v = 0.62;          // mortar
    } else if (kind === 'leaf') {
      v = 0.86 + (n2 - 0.5) * 0.22 + (n - 0.5) * 0.08;
    } else if (kind === 'grass') {
      v = 0.93 + (n2 - 0.5) * 0.06 + (n - 0.5) * 0.07;
      if (n > 0.97) v = 1.0;
    } else if (kind === 'soil') {
      v = 0.92 + (n2 - 0.5) * 0.06 + (n - 0.5) * 0.05 + (n > 0.95 ? 0.07 : 0);
    } else if (kind === 'lamp') {
      const e = Math.min(x, y, N - 1 - x, N - 1 - y);
      v = e < 12 ? 0.42 : (x > 60 && x < 68) || (y > 60 && y < 68) ? 0.5 : 1;
    }
    px(x, y, v);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export function createRenderer(opts) {
  const host = opts.host;
  const onPick = opts.onPick || function () {};
  const onHover = opts.onHover || function () {};
  let reducedMotion = !!opts.reducedMotion;
  let highContrast = !!opts.highContrast;
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const still = () => reducedMotion || !!(motionQuery && motionQuery.matches);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (e) { return null; }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const gpu = (function () {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (e) { return ''; }
  })();
  const mobile = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
  const detected = autoPreset(gpu, mobile);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

  // ---------- layers ----------
  const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_SELECT = 2, LAYER_FX = 3;
  const envGroup = new THREE.Group();    // ground, sky, trees
  const gameGroup = new THREE.Group();   // blocks, rocks, tiles
  const selectGroup = new THREE.Group(); // markers, ghosts
  const fxGroup = new THREE.Group();     // particles
  scene.add(envGroup, gameGroup, selectGroup, fxGroup);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6a7a55, 0.7);
  const sun = new THREE.DirectionalLight(0xfff2cc, 2.4);
  const SUN_DIR = new THREE.Vector3(8, 14, 6).normalize();
  sun.position.copy(SUN_DIR).multiplyScalar(20);
  sun.castShadow = false;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(hemi, sun, sun.target);

  // Shadow box fitted tightly around the plot (blocks included).
  function fitShadow() {
    const half = Math.hypot(Math.max(plotW, 4), Math.max(plotH, 4)) / 2 + 0.9;
    const sc = sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = Math.max(0.5, 20 - half - 6); sc.far = 20 + half + 4;
    sc.updateProjectionMatrix();
  }

  // ---------- image-based lighting (reflections) ----------
  let envTex = null;
  function environmentTexture() {
    if (!envTex) {
      const pm = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment(renderer);
      envTex = pm.fromScene(room, 0.04).texture;
      room.dispose && room.dispose();
      pm.dispose();
    }
    return envTex;
  }

  // ---------- shared geometry / materials ----------
  const boxGeo = new THREE.BoxGeometry(0.92, 0.92, 0.92);
  const roundGeo = new RoundedBoxGeometry(0.92, 0.92, 0.92, 2, 0.07);
  const tileGeo = new THREE.BoxGeometry(0.98, 0.12, 0.98);
  const topGeo = new THREE.BoxGeometry(0.5, 0.28, 0.5);
  const roundTopGeo = new RoundedBoxGeometry(0.5, 0.28, 0.5, 2, 0.05);
  const ringGeo = new THREE.RingGeometry(0.3, 0.42, 24);
  const discGeo = new THREE.CircleGeometry(0.16, 16);

  const tex = {};
  function texture(kind) {
    if (!tex[kind]) {
      tex[kind] = makeTexture(kind === 'ground' ? 'grass' : kind);
      if (kind === 'ground') tex[kind].repeat.set(10, 10);
    }
    return tex[kind];
  }

  // Materials are created once and updated in place, so meshes never hold
  // disposed materials across palette / quality changes.
  const mats = {
    wood: new THREE.MeshStandardMaterial({ roughness: 0.78 }),
    stone: new THREE.MeshStandardMaterial({ roughness: 0.88 }),
    glass: new THREE.MeshPhysicalMaterial({
      roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.7,
      clearcoat: 0.8, clearcoatRoughness: 0.1, ior: 1.45
    }),
    plant: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    plantTop: new THREE.MeshStandardMaterial({ roughness: 0.75 }),
    lamp: new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x6b6560, roughness: 1 }),
    tile: new THREE.MeshStandardMaterial({ roughness: 0.92 }),
    tileRock: new THREE.MeshStandardMaterial({ color: 0x7a746c, roughness: 1 }),
    soil: new THREE.MeshStandardMaterial({ roughness: 1 }),
    ground: new THREE.MeshStandardMaterial({ roughness: 1 }),
    water: new THREE.MeshPhysicalMaterial({ roughness: 0.22, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.15 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x7a5638, roughness: 1 }),
    crown: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    hill: new THREE.MeshStandardMaterial({ roughness: 1 }),
    cloud: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
    markerOk: new THREE.MeshBasicMaterial({ color: 0x7cfc9a, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    markerHover: new THREE.MeshBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    markerBad: new THREE.MeshBasicMaterial({ color: 0xff6a5e, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  };
  const LIT = ['wood', 'stone', 'glass', 'plant', 'plantTop', 'lamp', 'rock', 'tile', 'tileRock', 'soil',
    'ground', 'water', 'trunk', 'crown', 'hill', 'cloud'];

  function updateMats() {
    const colors = blockColors();
    const detailed = q.detail === 'detailed' && !highContrast;
    const map = (m, kind) => {
      const t = detailed ? texture(kind) : null;
      if (m.map !== t) { m.map = t; m.needsUpdate = true; }
    };
    mats.wood.color.set(colors.wood); map(mats.wood, 'wood');
    mats.stone.color.set(colors.stone); map(mats.stone, 'stone');
    mats.glass.color.set(colors.glass);
    mats.plant.color.set(colors.plant); map(mats.plant, 'leaf');
    mats.plantTop.color.set(colors.leaf); map(mats.plantTop, 'leaf');
    mats.lamp.color.set(colors.lamp); mats.lamp.emissive.set(colors.lamp);
    mats.lamp.emissiveIntensity = 2.2; map(mats.lamp, 'lamp');
    if (mats.lamp.emissiveMap !== mats.lamp.map) { mats.lamp.emissiveMap = mats.lamp.map; mats.lamp.needsUpdate = true; }
    mats.tile.color.set(colors.tile); map(mats.tile, 'grass');
    map(mats.tileRock, 'stone');
    mats.soil.color.set(colors.soil); map(mats.soil, 'soil');
    mats.ground.color.set(colors.ground); map(mats.ground, 'ground');
    mats.water.color.set(palette.water).multiplyScalar(0.8);
    mats.crown.color.set(palette.leaf);
    mats.hill.color.set(palette.horizon);
    // Reflections: environment map on everything lit, strongest on glossy pieces;
    // the hemisphere fill is lowered so overall exposure stays the same.
    const env = q.reflections === 'on';
    scene.environment = env ? environmentTexture() : null;
    LIT.forEach(k => { mats[k].envMapIntensity = 0.35; });
    mats.glass.envMapIntensity = 0.6; mats.water.envMapIntensity = 0.45; mats.lamp.envMapIntensity = 0.5;
    hemiBase = env ? 0.45 : 0.7;
  }
  let hemiBase = 0.7;

  const BLOCK_COLORS = {
    standard: { wood: 0xb07a45, stone: 0x8d9299, glass: 0x9fd8e8, plant: 0x6fbf5a, lamp: 0xffd27a, leaf: 0x4f8f3f },
    'high-visibility': { wood: 0xb7791f, stone: 0x9aa0a8, glass: 0x4cc9f0, plant: 0x2f9e44, lamp: 0xffd60a, leaf: 0x2f9e44 }
  };

  let palette = {
    sky: 0x87bfe8, horizon: 0xd8ecdc, ground: 0x77a95c, soil: 0x8a6a48,
    sun: 0xfff2cc, sunInt: 1.25, fog: 0xbcd8e8, water: 0x5f9fc8, leaf: 0x4f8f3f
  };
  let weather = 'sun';

  function blockColors() {
    const base = BLOCK_COLORS[highContrast ? 'high-visibility' : 'standard'];
    return Object.assign({}, base, { leaf: palette.leaf, tile: palette.ground, soil: palette.soil, ground: palette.ground });
  }

  // ---------- quality ----------
  let saved = {};
  let q = resolve(saved, detected);

  // ---------- plot state ----------
  let cfg = null;             // current rules cfg (plot dims)
  let lastState = null;
  let blockMeshes = [];       // rebuilt per setState
  let tiles = [];             // interaction-layer meshes per cell
  let plotW = 0, plotH = 0;
  let decorRngState = 0;
  let showcase = false;       // title-screen valley (no round loaded)

  function cellOrigin() {
    return { x: -((plotW - 1) * CELL) / 2, z: -((plotH - 1) * CELL) / 2 };
  }
  function cellPos(x, y, h) {
    const o = cellOrigin();
    return new THREE.Vector3(o.x + x * CELL, 0.06 + (h + 0.5) * 0.92, o.z + y * CELL);
  }

  function makeBlockMesh(type, x, y, h) {
    const detailed = q.detail === 'detailed';
    const g = new THREE.Group();
    const m = new THREE.Mesh(detailed ? roundGeo : boxGeo, mats[type] || mats.stone);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    if (type === 'plant') {
      const top = new THREE.Mesh(detailed ? roundTopGeo : topGeo, mats.plantTop);
      top.position.y = 0.55; top.castShadow = true;
      g.add(top);
    } else if (type === 'lamp') {
      const cap = new THREE.Mesh(detailed ? roundTopGeo : topGeo, mats.rock);
      cap.position.y = 0.55; cap.castShadow = true;
      g.add(cap);
    } else if (type === 'rock') {
      m.scale.set(1 + ((x * 7 + y * 13 + h * 5) % 3) * 0.05, 0.9, 1);
      m.rotation.y = ((x * 31 + y * 17 + h * 11) % 8) * 0.06;
    }
    g.position.copy(cellPos(x, y, h));
    g.userData = { x, y, h, type };
    return g;
  }

  // ---------- environment (seeded decor) ----------
  let decorGroup = null;
  let crowns = [], ripples = [], clouds = null, sky = null;
  function buildDecor(seed) {
    if (decorGroup) { envGroup.remove(decorGroup); disposeGroup(decorGroup); }
    decorGroup = new THREE.Group();
    crowns = []; ripples = [];
    const detailed = q.detail === 'detailed';
    // deterministic decor stream — cosmetic only
    let s = (seed ^ 0x85ebca6b) >>> 0;
    const rnd = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // valley floor
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(16, 18, 1.2, detailed ? 48 : 28), mats.ground);
    ground.position.y = -0.75; ground.receiveShadow = true;
    decorGroup.add(ground);
    // plot soil base
    const soil = new THREE.Mesh(
      new THREE.BoxGeometry(plotW + 1.2, 0.5, plotH + 1.2), mats.soil);
    soil.position.y = -0.28; soil.receiveShadow = true;
    decorGroup.add(soil);
    // pond
    const pondPos = new THREE.Vector3(plotW * 0.9 + 2.5, -0.12, plotH * 0.5);
    const pond = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32), mats.water);
    pond.rotation.x = -Math.PI / 2;
    pond.position.copy(pondPos);
    pond.receiveShadow = true;
    decorGroup.add(pond);
    if (detailed) {
      // stone rim + ripple rings (animated with the background setting)
      const rim = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.16, 6, 32), mats.rock);
      rim.rotation.x = -Math.PI / 2; rim.position.copy(pondPos); rim.position.y = -0.1;
      decorGroup.add(rim);
      for (let i = 0; i < 3; i++) {
        const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 32),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthWrite: false }));
        r.rotation.x = -Math.PI / 2; r.position.copy(pondPos); r.position.y = -0.1;
        r.position.x += (rnd() - 0.5) * 1.6; r.position.z += (rnd() - 0.5) * 1.6;
        r.userData.phase = i / 3;
        ripples.push(r); decorGroup.add(r);
      }
    }
    // low-poly trees on the outskirts
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 0.9, 6);
    const crownGeo = new THREE.ConeGeometry(0.65, 1.4, 7);
    const crownGeo2 = new THREE.ConeGeometry(0.5, 1.0, 7);
    const nTrees = detailed ? 14 : 5;
    const castTrees = q.shadows !== 'off';
    for (let i = 0; i < nTrees; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 6.5 + rnd() * 6;
      const t = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, mats.trunk);
      trunk.position.y = 0.4; trunk.castShadow = castTrees;
      const crown = new THREE.Group();
      const c1 = new THREE.Mesh(crownGeo, mats.crown);
      c1.position.y = 0.6; c1.castShadow = castTrees;
      crown.add(c1);
      if (detailed) {
        const c2 = new THREE.Mesh(crownGeo2, mats.crown);
        c2.position.y = 1.25; c2.castShadow = castTrees;
        crown.add(c2);
      }
      crown.position.y = 0.9;
      crown.userData.phase = rnd() * Math.PI * 2;
      crowns.push(crown);
      const sc = 0.8 + rnd() * 0.7;
      t.add(trunk, crown);
      t.scale.setScalar(sc);
      t.position.set(Math.cos(a) * r, -0.2, Math.sin(a) * r);
      decorGroup.add(t);
    }
    if (detailed) {
      // wildflowers and pebbles scattered around the plot (one instanced draw each)
      const fGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
      const fMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
      const nF = 90;
      const flowers = new THREE.InstancedMesh(fGeo, fMat, nF);
      const m4 = new THREE.Matrix4(), col = new THREE.Color();
      const FLOWER = [0xd9b93a, 0xd0607a, 0x8a6fd0, 0xe08a3a, 0xc9c0e8];
      const clearX = plotW / 2 + 1.2, clearZ = plotH / 2 + 1.2;
      for (let i = 0; i < nF; i++) {
        let x, z;
        do { x = (rnd() - 0.5) * 22; z = (rnd() - 0.5) * 22; }
        while ((Math.abs(x) < clearX && Math.abs(z) < clearZ) || Math.hypot(x - pondPos.x, z - pondPos.z) < 2.6 || Math.hypot(x, z) > 14.5);
        m4.makeScale(1, 0.6, 1).setPosition(x, -0.12, z);
        flowers.setMatrixAt(i, m4);
        flowers.setColorAt(i, col.set(FLOWER[i % FLOWER.length]));
      }
      flowers.raycast = () => {};
      decorGroup.add(flowers);
      for (let i = 0; i < 10; i++) {
        let x, z;
        do { x = (rnd() - 0.5) * 20; z = (rnd() - 0.5) * 20; }
        while ((Math.abs(x) < clearX && Math.abs(z) < clearZ) || Math.hypot(x - pondPos.x, z - pondPos.z) < 2.6);
        const p = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + rnd() * 0.22, 0), mats.rock);
        p.position.set(x, -0.1, z); p.rotation.set(rnd() * 3, rnd() * 3, 0);
        p.castShadow = castTrees; p.receiveShadow = true;
        decorGroup.add(p);
      }
    }
    // distant hills
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rnd();
      const hill = new THREE.Mesh(new THREE.ConeGeometry(4 + rnd() * 3, 3 + rnd() * 2, 7), mats.hill);
      hill.position.set(Math.cos(a) * 22, -0.5, Math.sin(a) * 22);
      decorGroup.add(hill);
    }
    decorGroup.traverse(o => { o.raycast = () => {}; });
    envGroup.add(decorGroup);
    fitShadow();
  }

  // Sky dome and drifting clouds (Detailed only; Plain uses the flat background colour).
  function buildSky() {
    if (sky) { envGroup.remove(sky); sky.geometry.dispose(); sky.material.dispose(); sky = null; }
    if (clouds) { envGroup.remove(clouds); disposeGroup(clouds); clouds = null; }
    if (q.detail !== 'detailed') return;
    sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
        uSunDir: { value: SUN_DIR.clone() }, uSun: { value: new THREE.Color() }
      },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false
    }));
    sky.raycast = () => {};
    sky.renderOrder = -1;
    envGroup.add(sky);
    clouds = new THREE.Group();
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 7; i++) {
      const c = new THREE.Group();
      const n = 3 + (i % 3);
      for (let k = 0; k < n; k++) {
        const p = new THREE.Mesh(puff, mats.cloud);
        p.position.set((k - n / 2) * 1.3, Math.sin(k * 2.1 + i) * 0.3, Math.cos(k * 1.7 + i) * 0.6);
        p.scale.setScalar(1.1 + ((k + i) % 3) * 0.35);
        c.add(p);
      }
      const a = (i / 7) * Math.PI * 2 + 0.4;
      c.position.set(Math.cos(a) * 26, 12 + (i % 3) * 2, Math.sin(a) * 26);
      c.scale.set(1.4, 0.7, 1);
      c.lookAt(0, c.position.y, 0);
      clouds.add(c);
    }
    clouds.traverse(o => { o.raycast = () => {}; });
    envGroup.add(clouds);
  }

  // ---------- weather + ambient particles ----------
  let rain = null, rainVel = null, motes = null;
  function buildParticles() {
    if (rain) { fxGroup.remove(rain); rain.geometry.dispose(); rain.material.dispose(); rain = null; }
    if (motes) { fxGroup.remove(motes); motes.geometry.dispose(); motes.material.dispose(); motes = null; }
    const n = q.particles === 'high' ? 1600 : q.particles === 'low' ? 600 : 0;
    if (!n) return;
    const pos = new Float32Array(n * 3);
    rainVel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 24;
      pos[i * 3 + 1] = Math.random() * 12;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 24;
      rainVel[i] = 6 + Math.random() * 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rain = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xbfd8ee, size: 0.07, transparent: true, opacity: 0.0, depthWrite: false
    }));
    rain.raycast = () => {};
    fxGroup.add(rain);
    if (q.particles === 'high') {
      // sunlit pollen motes drifting over the plot
      const m = 60, mp = new Float32Array(m * 3);
      for (let i = 0; i < m; i++) {
        mp[i * 3] = (Math.random() - 0.5) * 14; mp[i * 3 + 1] = 0.3 + Math.random() * 4;
        mp[i * 3 + 2] = (Math.random() - 0.5) * 14;
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
      motes = new THREE.Points(mg, new THREE.PointsMaterial({
        color: 0xfff4c8, size: 0.035, transparent: true, opacity: 0.4, depthWrite: false
      }));
      motes.raycast = () => {};
      fxGroup.add(motes);
    }
  }

  function applyAtmosphere() {
    const dim = weather === 'rain' ? 0.45 : weather === 'cloud' ? 0.7 : 1;
    sun.intensity = 2.4 * palette.sunInt * dim;
    sun.color.set(palette.sun);
    hemi.intensity = hemiBase * (weather === 'rain' ? 0.7 : 1);
    const fogC = new THREE.Color(palette.fog).multiplyScalar(weather === 'sun' ? 1 : 0.85);
    scene.fog = new THREE.Fog(fogC, 26, 60);
    scene.background = new THREE.Color(palette.sky).lerp(fogC, weather === 'sun' ? 0.15 : 0.55);
    if (sky) {
      const u = sky.material.uniforms;
      u.uTop.value.copy(scene.background);
      u.uHorizon.value.copy(fogC);
      u.uSun.value.set(palette.sun).multiplyScalar(weather === 'sun' ? 1 : 0.15);
    }
    if (clouds) {
      mats.cloud.color.set(weather === 'rain' ? 0x9aa4ae : weather === 'cloud' ? 0xd8dee4 : 0xffffff);
      clouds.visible = true;
    }
    if (rain) rain.material.opacity = weather === 'rain' ? 0.55 : 0.0;
    if (motes) motes.visible = weather === 'sun';
  }

  // ---------- selection / ghost ----------
  const marker = new THREE.Mesh(ringGeo, mats ? mats.markerHover : undefined);
  const ghostMesh = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false
  }));
  const targetDiscs = [];
  function setupSelect() {
    marker.rotation.x = -Math.PI / 2;
    marker.visible = false;
    marker.raycast = () => {};
    ghostMesh.visible = false;
    ghostMesh.raycast = () => {};
    selectGroup.add(marker, ghostMesh);
  }

  // ---------- camera control (spring, interruptible) ----------
  const camTarget = { theta: FRAMING.theta, phi: FRAMING.phi, dist: FRAMING.dist };
  const camCur = { theta: FRAMING.theta, phi: FRAMING.phi, dist: FRAMING.dist };
  // Safe rectangle of the canvas not covered by HUD panels (fractions of the
  // canvas). Panels hugging an edge carve that edge off.
  function hudInsets() {
    const ins = { l: 0, r: 0, t: 0, b: 0 };
    const rect = renderer.domElement.getBoundingClientRect();
    const W = rect.width || 1, H = rect.height || 1;
    for (const id of ['hud-top', 'hud-goals', 'hud-actions', 'hud-palette', 'hud-message']) {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden') || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const e = { l: (r.left - rect.left) / W, t: (r.top - rect.top) / H, r: (r.right - rect.left) / W, b: (r.bottom - rect.top) / H };
      if (e.b <= 0.4 && e.r - e.l > 0.5) ins.t = Math.max(ins.t, e.b);
      else if (e.t >= 0.6) ins.b = Math.max(ins.b, 1 - e.t);
      else if (e.r <= 0.42) ins.l = Math.max(ins.l, e.r);
      else if (e.l >= 0.58) ins.r = Math.max(ins.r, 1 - e.l);
      else if (e.b <= 0.45) ins.t = Math.max(ins.t, e.b);
      else if (e.t >= 0.5) ins.b = Math.max(ins.b, 1 - e.t);
    }
    if (ins.l + ins.r > 0.55) { ins.l = 0; ins.r = 0; }
    if (ins.t + ins.b > 0.6) { ins.t = Math.min(ins.t, 0.3); ins.b = Math.min(ins.b, 0.3); }
    return ins;
  }

  // Distance at which the whole plot (all columns up to the max height) fits
  // inside the HUD-free rectangle at the given orbit angles.
  function fitDistance(theta, phi) {
    const ins = hudInsets();
    const freeW = Math.max(0.35, 1 - ins.l - ins.r - 0.06);
    const freeH = Math.max(0.35, 1 - ins.t - ins.b - 0.06);
    const hw = plotW / 2 + 0.6, hd = plotH / 2 + 0.6, top = Math.max(2.5, (cfg && cfg.plot && cfg.plot.maxH) || 3);
    const corners = [];
    for (const x of [-hw, hw]) for (const z of [-hd, hd]) for (const y of [0, top]) corners.push(new THREE.Vector3(x, y, z));
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
    const dirCam = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(phi), Math.cos(theta) * Math.cos(phi));
    const look = new THREE.Vector3(0, 0.8, 0);
    fwd.copy(dirCam).negate();
    right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    up.crossVectors(right, fwd).normalize();
    let need = 0;
    const rel = new THREE.Vector3();
    for (const c of corners) {
      rel.copy(c).sub(look);
      const depth = -rel.dot(fwd); // positive toward the camera
      const x = Math.abs(rel.dot(right)), y = Math.abs(rel.dot(up));
      need = Math.max(need, x / (tanH * freeW) + depth, y / (tanV * freeH) + depth);
    }
    return Math.max(5, need);
  }

  function resetCamera() {
    camTarget.theta = FRAMING.theta; camTarget.phi = FRAMING.phi;
    camTarget.dist = fitDistance(FRAMING.theta, FRAMING.phi);
  }
  function fitCamera() {
    camTarget.dist = fitDistance(camTarget.theta, camTarget.phi);
  }
  function topDownCamera() {
    camTarget.phi = 1.35;
    camTarget.dist = fitDistance(camTarget.theta, 1.35);
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let dragging = false, dragMoved = 0, lastX = 0, lastY = 0, downTime = 0, activePointer = null;

  function pickCell(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    ray.layers.set(LAYER_GAME);
    const hits = ray.intersectObjects(tiles, false);
    if (hits.length) {
      const u = hits[0].object.userData;
      return { x: u.x, y: u.y };
    }
    return null;
  }

  function onPointerDown(ev) {
    if (activePointer !== null) return;
    activePointer = ev.pointerId;
    renderer.domElement.setPointerCapture(ev.pointerId);
    dragging = true; dragMoved = 0; downTime = performance.now();
    lastX = ev.clientX; lastY = ev.clientY;
  }
  function onPointerMove(ev) {
    if (dragging && ev.pointerId === activePointer) {
      const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
      dragMoved += Math.abs(dx) + Math.abs(dy);
      if (dragMoved > 8) { // camera gesture: orbit
        camTarget.theta -= dx * 0.005;
        camTarget.phi = Math.min(1.35, Math.max(0.55, camTarget.phi - dy * 0.004));
      }
      lastX = ev.clientX; lastY = ev.clientY;
    } else if (ev.pointerType === 'mouse') {
      const c = pickCell(ev);
      onHover(c);
    }
  }
  function onPointerUp(ev) {
    if (ev.pointerId !== activePointer) return;
    try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch (e) {}
    activePointer = null;
    const wasTap = dragging && dragMoved <= 8 && (performance.now() - downTime) < 600;
    dragging = false;
    if (wasTap) {
      const c = pickCell(ev);
      if (c) onPick(c.x, c.y);
      else onHover(null);
    }
  }
  function onPointerCancel(ev) {
    if (ev.pointerId === activePointer) { activePointer = null; dragging = false; }
  }
  function onWheel(ev) {
    ev.preventDefault();
    // Zoom bounds follow the plot: never closer than half the fitted distance,
    // never further than twice it.
    const fit = fitDistance(camTarget.theta, camTarget.phi);
    camTarget.dist = Math.min(fit * 2, Math.max(fit * 0.5, camTarget.dist + ev.deltaY * 0.01));
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerCancel);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  // ---------- state rebuild ----------
  function disposeGroup(g) {
    g.traverse(o => { if (o.geometry && !isShared(o.geometry)) o.geometry.dispose(); });
  }
  const sharedGeos = new Set([boxGeo, roundGeo, tileGeo, topGeo, roundTopGeo, ringGeo, discGeo]);
  function isShared(g) { return sharedGeos.has(g); }

  let flashes = []; // {x,y,h,t,kind}
  function setState(state, opts2) {
    opts2 = opts2 || {};
    const wasShowcase = showcase;
    showcase = !!opts2.showcase;
    const rebuildLayout = opts2.force || wasShowcase !== showcase || !cfg || cfg.plot.cols !== state.cfg.plot.cols ||
      cfg.plot.rows !== state.cfg.plot.rows || decorRngState !== state.seed;
    lastState = state;
    cfg = state.cfg;
    plotW = cfg.plot.cols; plotH = cfg.plot.rows;
    decorRngState = state.seed;

    if (rebuildLayout) {
      // tiles
      tiles.forEach(t => gameGroup.remove(t));
      tiles = [];
      for (let y = 0; y < plotH; y++) for (let x = 0; x < plotW; x++) {
        const hasRock = state.grid[y][x].indexOf('rock') >= 0;
        const t = new THREE.Mesh(tileGeo, hasRock ? mats.tileRock : mats.tile);
        const o = cellOrigin();
        t.position.set(o.x + x * CELL, 0, o.z + y * CELL);
        t.receiveShadow = true;
        t.userData = { x, y };
        t.layers.set(LAYER_GAME);
        tiles.push(t);
        gameGroup.add(t);
      }
      buildDecor(state.seed);
      if (!opts2.keepCamera) {
        resetCamera();
        camCur.dist = camTarget.dist;
      }
    }

    // blocks: rebuild (plots are small; shared geo/mats keep this cheap)
    blockMeshes.forEach(g => gameGroup.remove(g));
    blockMeshes = [];
    for (let y = 0; y < plotH; y++) for (let x = 0; x < plotW; x++) {
      const st = state.grid[y][x];
      for (let h = 0; h < st.length; h++) {
        const g = makeBlockMesh(st[h], x, y, h);
        blockMeshes.push(g);
        gameGroup.add(g);
      }
    }

    if (!reducedMotion && opts2.events) {
      opts2.events.forEach(e => {
        if ((e.type === 'place' || e.type === 'remove') && e.x != null) {
          flashes.push({ x: e.x, y: e.y, h: e.h || 0, t: 0, kind: e.type });
        }
      });
    }
  }

  // Title-screen showcase: a small finished homestead that slowly turns.
  function showShowcase() {
    const B = [
      '.W.S..', 'WWGSS.', '.WLPS.', '..PPL.', 'S....W', '.G..WW'
    ];
    const T = { W: ['wood', 'wood'], S: ['stone', 'stone', 'glass'], G: ['glass'], L: ['stone', 'lamp'], P: ['plant'] };
    const grid = B.map(row => row.split('').map(ch => (T[ch] || []).slice()));
    grid[1][1].push('wood'); grid[2][1].push('glass');
    ghost(null); highlightTargets([], null);
    setState({ cfg: { plot: { cols: 6, rows: 6, maxH: 3 } }, grid, seed: 20240917 }, { showcase: true });
  }

  function highlightTargets(cells, block) {
    targetDiscs.forEach(d => selectGroup.remove(d));
    targetDiscs.length = 0;
    (cells || []).forEach(c => {
      const d = new THREE.Mesh(discGeo, mats.markerOk);
      d.rotation.x = -Math.PI / 2;
      const o = cellOrigin();
      d.position.set(o.x + c.x * CELL, 0.13 + (c.h || 0) * 0.92, o.z + c.y * CELL);
      d.raycast = () => {};
      targetDiscs.push(d);
      selectGroup.add(d);
    });
    ghostMesh.material.color.set(block ? 0x9fff9f : 0xffffff);
  }

  function ghost(x, y, h, valid) {
    if (x == null) { ghostMesh.visible = false; marker.visible = false; return; }
    ghostMesh.visible = true;
    ghostMesh.position.copy(cellPos(x, y, h));
    ghostMesh.material.color.set(valid ? 0x9fff9f : 0xff8a7a);
    marker.visible = true;
    marker.material = valid ? mats.markerHover : mats.markerBad;
    const o = cellOrigin();
    marker.position.set(o.x + x * CELL, 0.14, o.z + y * CELL);
  }

  // ---------- graphics settings ----------
  let composer = null, gradePass = null, postKey = null, postFailed = false;
  let adaptiveScale = 1, frames = [], fps = 0;
  let size = [0, 0], pixelRatio = 1;

  /** Apply saved graphics settings (settings.gfx) live. */
  let savedJson = null;
  function setGraphics(next) {
    const json = JSON.stringify(next || {});
    if (json === savedJson) return; // unrelated settings changed
    savedJson = json;
    saved = Object.assign({}, next || {});
    const prev = q;
    q = resolve(saved, detected);
    const shadowSize = SHADOW_MAP[q.shadows];
    const shadowChanged = renderer.shadowMap.enabled !== shadowSize > 0;
    renderer.shadowMap.enabled = shadowSize > 0;
    sun.castShadow = shadowSize > 0;
    if (shadowSize > 0 && sun.shadow.mapSize.x !== shadowSize) {
      sun.shadow.mapSize.set(shadowSize, shadowSize);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    updateMats();
    if (shadowChanged) LIT.forEach(k => { mats[k].needsUpdate = true; });
    const skyWrong = !!sky !== (q.detail === 'detailed');
    if (skyWrong || prev.detail !== q.detail || (prev.shadows === 'off') !== (q.shadows === 'off')) {
      buildSky();
      if (lastState) setState(lastState, { force: true, keepCamera: true, showcase });
    }
    if (prev.particles !== q.particles || !rainVel) buildParticles();
    applyAtmosphere();
    adaptiveScale = 1; frames = [];
    postKey = null; // rebuild the post chain on the next frame
    fpsVisible(q.showFps);
    renderer.domElement.dataset.gfxPreset = q.preset;
    document.body.setAttribute('data-gfx-preset', q.preset);
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost. */
  function graphicsInfo() {
    const px = [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)];
    return {
      gpu: gpu || 'unknown GPU', detected, resolved: q,
      summary: describe(q, px), fps: Math.round(fps),
      adaptiveScale: Math.round(adaptiveScale * 100) / 100, postFailed
    };
  }

  function fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }

  function buildPost(w, h) {
    if (composer) { composer.dispose(); composer = null; }
    gradePass = null;
    if (!q.post || postFailed) return;
    try {
      const W = Math.max(1, Math.round(w * pixelRatio)), H = Math.max(1, Math.round(h * pixelRatio));
      const target = new THREE.WebGLRenderTarget(W, H, {
        type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0
      });
      const c = new EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new RenderPass(scene, camera));
      if (q.ao !== 'off') {
        const ao = new GTAOPass(scene, camera, W, H);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: q.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: q.ao === 'high' ? 6 : 4, rings: 2, samples: q.ao === 'high' ? 16 : 8 });
        c.addPass(ao);
      }
      if (q.bloom === 'on') {
        // High threshold: only lamps, glints and sunlit glass bloom.
        c.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.4, 0.35, 0.95));
      }
      c.addPass(new OutputPass());
      if (q.grade === 'on') {
        gradePass = new ShaderPass(GradeShader);
        gradePass.uniforms.uVignette.value = highContrast ? 0 : 0.2;
        c.addPass(gradePass);
      }
      if (q.antialias === 'smaa') c.addPass(new SMAAPass(W, H));
      if (q.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / W, 1 / H);
        c.addPass(fxaa);
      }
      composer = c;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      postFailed = true;
      composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  function adapt(dtMs) {
    frames.push(dtMs);
    if (frames.length < 90) return false;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    frames.length = 0;
    fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
    if (!q.adaptive) return false;
    const before = adaptiveScale;
    if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
    else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
    return before !== adaptiveScale;
  }

  function setPalette(p, hc) {
    palette = p || palette;
    if (hc != null) highContrast = hc;
    updateMats();
    applyAtmosphere();
    postKey = null;
    if (cfg) { decorRngState = 0; } // force decor rebuild on next setState
  }

  function setWeather(w) { weather = w; applyAtmosphere(); }
  function setReducedMotion(b) { reducedMotion = !!b; }

  // ---------- resize / visibility ----------
  function viewSize() {
    return [host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight];
  }
  function applySize(force) {
    const [w, h] = viewSize();
    const ratio = Math.min(window.devicePixelRatio || 1, q.dprCap) * q.scale * adaptiveScale;
    if (!force && w === size[0] && h === size[1] && ratio === pixelRatio) return false;
    const aspectChanged = w !== size[0] || h !== size[1];
    size = [w, h]; pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (aspectChanged && cfg) fitCamera();
    return true;
  }
  function resize() { applySize(true); }
  window.addEventListener('resize', resize);

  let running = true, raf = 0;
  function setRunning(b) {
    if (b === running) return;
    running = b;
    if (b) { lastT = performance.now(); loop(lastT); }
  }

  let lastT = performance.now(), clock = 0;
  function loop(t) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const rawMs = Math.min(250, t - lastT);
    const dt = Math.min(0.05, rawMs / 1000);
    lastT = t;
    const moving = !still();
    if (moving) clock += dt;

    adapt(rawMs);
    applySize(false);

    // title showcase: slow turntable
    if (showcase && moving) camTarget.theta += dt * 0.06;

    // critically-damped-ish camera spring (interruptible, no cumulative lerp drift)
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    camCur.theta += (camTarget.theta - camCur.theta) * k;
    camCur.phi += (camTarget.phi - camCur.phi) * k;
    camCur.dist += (camTarget.dist - camCur.dist) * k;
    const cy = Math.sin(camCur.phi) * camCur.dist;
    const ch = Math.cos(camCur.phi) * camCur.dist;
    camera.position.set(Math.sin(camCur.theta) * ch, cy, Math.cos(camCur.theta) * ch);
    camera.lookAt(0, 0.8, 0);

    // placement flashes: brief scale pop on the affected column top
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      const m = blockMeshes.find(g => g.userData.x === f.x && g.userData.y === f.y && g.userData.h === f.h);
      if (m) {
        const s = 1 + Math.max(0, 0.25 * (1 - f.t / 0.25));
        m.scale.setScalar(f.t < 0.25 ? s : 1);
      }
      if (f.t > 0.3) flashes.splice(i, 1);
    }

    // ambient scenery (Background: animated; frozen under reduced motion)
    const animated = q.background === 'animated' && moving;
    if (animated) {
      const gust = weather === 'rain' ? 2.2 : weather === 'cloud' ? 1.4 : 1;
      for (const c of crowns) {
        c.rotation.z = Math.sin(clock * 1.3 + c.userData.phase) * 0.04 * gust;
        c.rotation.x = Math.cos(clock * 1.1 + c.userData.phase) * 0.03 * gust;
      }
      if (clouds) clouds.rotation.y += dt * 0.012;
      for (const r of ripples) {
        const p = (clock * 0.35 + r.userData.phase) % 1;
        r.scale.setScalar(0.3 + p * 1.4);
        r.material.opacity = 0.35 * (1 - p) * (weather === 'rain' ? 1.6 : 1);
      }
    } else {
      for (const r of ripples) r.material.opacity = 0;
    }

    // rain
    if (rain && rain.material.opacity > 0.01 && !document.hidden && moving) {
      const p = rain.geometry.attributes.position.array;
      for (let i = 0; i < rainVel.length; i++) {
        p[i * 3 + 1] -= rainVel[i] * dt;
        if (p[i * 3 + 1] < 0) p[i * 3 + 1] = 12;
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }
    if (motes && motes.visible && moving) {
      motes.rotation.y += dt * 0.03;
      motes.position.y = Math.sin(clock * 0.4) * 0.25;
    }

    const key = q.post && !postFailed ? [q.ao, q.bloom, q.grade, q.antialias, size[0], size[1], pixelRatio].join('|') : 'none';
    if (key !== postKey) { postKey = key; buildPost(size[0], size[1]); }
    if (composer) {
      try { composer.render(dt); }
      catch (e) { postFailed = true; composer.dispose(); composer = null; renderer.render(scene, camera); }
    } else {
      renderer.render(scene, camera);
    }
  }

  // ---------- context loss ----------
  renderer.domElement.addEventListener('webglcontextlost', ev => {
    ev.preventDefault();
    if (opts.onContextLost) opts.onContextLost();
  });

  // ---------- init ----------
  setupSelect();
  setGraphics(opts.graphics || {});
  applySize(true);
  resetCamera();
  camCur.dist = camTarget.dist + 6; // small intro swoop (skipped under reduced motion)
  if (reducedMotion) camCur.dist = camTarget.dist;
  loop(performance.now());

  return {
    setState, highlightTargets, ghost, setPalette, setWeather, setGraphics, graphicsInfo,
    showShowcase,
    setReducedMotion, resetCamera, fitCamera, topDownCamera, resize, setRunning,
    flashCell: (x, y, h) => flashes.push({ x, y, h, t: 0, kind: 'place' }),
    skipAnimations: () => { flashes.length = 0; camCur.theta = camTarget.theta; camCur.phi = camTarget.phi; camCur.dist = camTarget.dist; },
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      if (composer) composer.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    },
    domElement: renderer.domElement
  };
}
