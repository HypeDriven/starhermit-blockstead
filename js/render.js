/* Blockstead — Three.js renderer (ES module).
 * Sunny voxel valley with changing weather. The render layer consumes
 * immutable rules snapshots; it never mutates game state. Raycasts run
 * only against the explicit cell-interaction layer; particles and decor
 * never intercept picks. All decorative randomness uses the decor stream.
 */
import * as THREE from '../vendor/three.module.min.js';

const CELL = 1;                 // world units per plot cell
const FRAMING = { phi: 0.95, theta: 0.65, dist: 11 }; // authored default framing
const DPR_CAP = { low: 1, medium: 1.5, high: 2 };

export function createRenderer(opts) {
  const host = opts.host;
  const onPick = opts.onPick || function () {};
  const onHover = opts.onHover || function () {};
  let reducedMotion = !!opts.reducedMotion;
  let highContrast = !!opts.highContrast;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (e) { return null; }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

  // ---------- layers ----------
  const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_SELECT = 2, LAYER_FX = 3;
  const envGroup = new THREE.Group();    // ground, sky, trees
  const gameGroup = new THREE.Group();   // blocks, rocks, tiles
  const selectGroup = new THREE.Group(); // markers, ghosts
  const fxGroup = new THREE.Group();     // particles
  scene.add(envGroup, gameGroup, selectGroup, fxGroup);
  fxGroup.traverse(o => { o.raycast = () => {}; });

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6a7a55, 0.7);
  const sun = new THREE.DirectionalLight(0xfff2cc, 2.4);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
  sun.shadow.bias = -0.0015;
  scene.add(hemi, sun, sun.target);

  // ---------- shared geometry / materials ----------
  const boxGeo = new THREE.BoxGeometry(0.92, 0.92, 0.92);
  const tileGeo = new THREE.BoxGeometry(0.98, 0.12, 0.98);
  const topGeo = new THREE.BoxGeometry(0.5, 0.28, 0.5);
  const ringGeo = new THREE.RingGeometry(0.3, 0.42, 24);
  const discGeo = new THREE.CircleGeometry(0.16, 16);

  const mats = {};
  function makeMats(colors) {
    Object.values(mats).forEach(m => m.dispose && m.dispose());
    mats.wood = new THREE.MeshStandardMaterial({ color: colors.wood, roughness: 0.85 });
    mats.stone = new THREE.MeshStandardMaterial({ color: colors.stone, roughness: 0.95 });
    mats.glass = new THREE.MeshStandardMaterial({
      color: colors.glass, roughness: 0.15, metalness: 0.1,
      transparent: true, opacity: 0.72
    });
    mats.plant = new THREE.MeshStandardMaterial({ color: colors.plant, roughness: 0.8 });
    mats.plantTop = new THREE.MeshStandardMaterial({ color: colors.leaf, roughness: 0.8 });
    mats.lamp = new THREE.MeshStandardMaterial({
      color: colors.lamp, roughness: 0.4, emissive: colors.lamp, emissiveIntensity: 0.85
    });
    mats.rock = new THREE.MeshStandardMaterial({ color: 0x6b6560, roughness: 1 });
    mats.tile = new THREE.MeshStandardMaterial({ color: colors.tile, roughness: 0.9 });
    mats.tileRock = new THREE.MeshStandardMaterial({ color: 0x7a746c, roughness: 1 });
    mats.soil = new THREE.MeshStandardMaterial({ color: colors.soil, roughness: 1 });
    mats.ground = new THREE.MeshStandardMaterial({ color: colors.ground, roughness: 1 });
    mats.markerOk = new THREE.MeshBasicMaterial({ color: 0x7cfc9a, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    mats.markerHover = new THREE.MeshBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    mats.markerBad = new THREE.MeshBasicMaterial({ color: 0xff6a5e, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  }

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

  // ---------- plot state ----------
  let cfg = null;             // current rules cfg (plot dims)
  let blockMeshes = [];       // rebuilt per setState
  let tiles = [];             // interaction-layer meshes per cell
  let plotW = 0, plotH = 0;
  let decorRngState = 0;

  function cellOrigin() {
    return { x: -((plotW - 1) * CELL) / 2, z: -((plotH - 1) * CELL) / 2 };
  }
  function cellPos(x, y, h) {
    const o = cellOrigin();
    return new THREE.Vector3(o.x + x * CELL, 0.06 + (h + 0.5) * 0.92, o.z + y * CELL);
  }

  function makeBlockMesh(type, x, y, h) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(boxGeo, mats[type] || mats.stone);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    if (type === 'plant') {
      const top = new THREE.Mesh(topGeo, mats.plantTop);
      top.position.y = 0.55; top.castShadow = true;
      g.add(top);
    } else if (type === 'lamp') {
      const cap = new THREE.Mesh(topGeo, mats.rock);
      cap.position.y = 0.55;
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
  function buildDecor(seed) {
    if (decorGroup) { envGroup.remove(decorGroup); disposeGroup(decorGroup); }
    decorGroup = new THREE.Group();
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
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(16, 18, 1.2, 28), mats.ground);
    ground.position.y = -0.75; ground.receiveShadow = true;
    decorGroup.add(ground);
    // plot soil base
    const soil = new THREE.Mesh(
      new THREE.BoxGeometry(plotW + 1.2, 0.5, plotH + 1.2), mats.soil);
    soil.position.y = -0.28; soil.receiveShadow = true;
    decorGroup.add(soil);
    // pond
    const pond = new THREE.Mesh(new THREE.CircleGeometry(2.2, 22),
      new THREE.MeshStandardMaterial({ color: palette.water, roughness: 0.25 }));
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(plotW * 0.9 + 2.5, -0.12, plotH * 0.5);
    decorGroup.add(pond);
    // low-poly trees on the outskirts
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 0.9, 6);
    const crownGeo = new THREE.ConeGeometry(0.65, 1.4, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5638, roughness: 1 });
    const crownMat = new THREE.MeshStandardMaterial({ color: palette.leaf, roughness: 0.9 });
    const nTrees = quality === 'low' ? 5 : 10;
    for (let i = 0; i < nTrees; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 6.5 + rnd() * 6;
      const t = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 0.4; trunk.castShadow = quality !== 'low';
      const crown = new THREE.Mesh(crownGeo, crownMat);
      crown.position.y = 1.5; crown.castShadow = quality !== 'low';
      const sc = 0.8 + rnd() * 0.7;
      t.add(trunk, crown);
      t.scale.setScalar(sc);
      t.position.set(Math.cos(a) * r, -0.2, Math.sin(a) * r);
      decorGroup.add(t);
    }
    // distant hills
    const hillMat = new THREE.MeshStandardMaterial({ color: palette.horizon, roughness: 1 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rnd();
      const hill = new THREE.Mesh(new THREE.ConeGeometry(4 + rnd() * 3, 3 + rnd() * 2, 7), hillMat);
      hill.position.set(Math.cos(a) * 22, -0.5, Math.sin(a) * 22);
      decorGroup.add(hill);
    }
    envGroup.add(decorGroup);
  }

  // ---------- weather ----------
  let rain = null, rainVel = null;
  function buildRain() {
    const n = quality === 'low' ? 0 : quality === 'medium' ? 600 : 1600;
    if (rain) { fxGroup.remove(rain); rain.geometry.dispose(); rain.material.dispose(); rain = null; }
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
      color: 0xbfd8ee, size: 0.07, transparent: true, opacity: 0.0
    }));
    rain.raycast = () => {};
    fxGroup.add(rain);
  }

  function applyAtmosphere() {
    const dim = weather === 'rain' ? 0.45 : weather === 'cloud' ? 0.7 : 1;
    sun.intensity = 2.4 * palette.sunInt * dim;
    sun.color.set(palette.sun);
    hemi.intensity = 0.7 * (weather === 'rain' ? 0.7 : 1);
    const fogC = new THREE.Color(palette.fog).multiplyScalar(weather === 'sun' ? 1 : 0.85);
    scene.fog = new THREE.Fog(fogC, 26, 60);
    scene.background = new THREE.Color(palette.sky).lerp(fogC, weather === 'sun' ? 0.15 : 0.55);
    if (rain) rain.material.opacity = weather === 'rain' ? 0.55 : 0.0;
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
  function resetCamera() {
    camTarget.theta = FRAMING.theta; camTarget.phi = FRAMING.phi;
    camTarget.dist = FRAMING.dist + Math.max(plotW, plotH) * 0.6;
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
        camTarget.phi = Math.min(1.35, Math.max(0.35, camTarget.phi - dy * 0.004));
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
    camTarget.dist = Math.min(26, Math.max(5, camTarget.dist + ev.deltaY * 0.01));
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
  const sharedGeos = new Set([boxGeo, tileGeo, topGeo, ringGeo, discGeo]);
  function isShared(g) { return sharedGeos.has(g); }

  let flashes = []; // {x,y,h,t,kind}
  function setState(state, opts2) {
    opts2 = opts2 || {};
    const rebuildLayout = !cfg || cfg.plot.cols !== state.cfg.plot.cols ||
      cfg.plot.rows !== state.cfg.plot.rows || decorRngState !== state.seed;
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
      resetCamera();
      camCur.dist = camTarget.dist;
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

  // ---------- quality / settings ----------
  let quality = 'high';
  function setQuality(tier) {
    quality = tier;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP[tier] || 2));
    sun.castShadow = tier !== 'low';
    buildRain();
    applyAtmosphere();
  }

  function setPalette(p, hc) {
    palette = p || palette;
    if (hc != null) highContrast = hc;
    makeMats(blockColors());
    applyAtmosphere();
    if (cfg) { decorRngState = 0; } // force decor rebuild on next setState
  }

  function setWeather(w) { weather = w; applyAtmosphere(); }
  function setReducedMotion(b) { reducedMotion = !!b; }

  // ---------- resize / visibility ----------
  function resize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let running = true, raf = 0;
  function setRunning(b) {
    if (b === running) return;
    running = b;
    if (b) loop(performance.now());
  }

  let lastT = performance.now();
  function loop(t) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;

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

    // rain
    if (rain && rain.material.opacity > 0.01 && !document.hidden) {
      const p = rain.geometry.attributes.position.array;
      for (let i = 0; i < rainVel.length; i++) {
        p[i * 3 + 1] -= rainVel[i] * dt;
        if (p[i * 3 + 1] < 0) p[i * 3 + 1] = 12;
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  // ---------- context loss ----------
  renderer.domElement.addEventListener('webglcontextlost', ev => {
    ev.preventDefault();
    if (opts.onContextLost) opts.onContextLost();
  });

  // ---------- init ----------
  makeMats(blockColors());
  setupSelect();
  applyAtmosphere();
  buildRain();
  setQuality(opts.quality || 'high');
  resetCamera();
  camCur.dist = camTarget.dist + 6; // small intro swoop (skipped under reduced motion)
  if (reducedMotion) camCur.dist = camTarget.dist;
  loop(performance.now());

  return {
    setState, highlightTargets, ghost, setPalette, setWeather, setQuality,
    setReducedMotion, resetCamera, resize, setRunning,
    flashCell: (x, y, h) => flashes.push({ x, y, h, t: 0, kind: 'place' }),
    skipAnimations: () => { flashes.length = 0; camCur.theta = camTarget.theta; camCur.phi = camTarget.phi; camCur.dist = camTarget.dist; },
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
      host.removeChild(renderer.domElement);
    },
    domElement: renderer.domElement
  };
}
