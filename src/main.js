import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/cormorant-garamond/600.css';
import './style.css';
import { createWorld } from './world.js';
import { createGroundLayer } from './ground.js';
import { createStreaming } from './streaming.js';
import { createGrass } from './grass.js';
import { createTrees } from './trees.js';
import { createFoliage } from './foliage.js';
import { createParticles } from './particles.js';
import { createStream } from './stream.js';
import { createGarden } from './garden.js';
import { createComposer } from './postprocess.js';
import { toonify, toonifyMaterials } from './toon.js';
import { updateWind } from './wind.js';
import { streamCurve, levelAt, halfWidthAt, HOME_T, LOOK_T, originalT } from './streamPath.js';
import { installGlobalRandom } from './rng.js';

installGlobalRandom();

const CAPTURE = new URLSearchParams(location.search).has('capture');
const MAX_PIXEL_RATIO = 1.5;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: CAPTURE });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.32;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1600);

const camP = streamCurve.getPointAt(HOME_T);
const lookP = streamCurve.getPointAt(LOOK_T);
const LOOK = new THREE.Vector3(lookP.x, levelAt(LOOK_T) + 0.5, lookP.z);
camera.position.set(camP.x - 5.5, levelAt(HOME_T) + 11.6, camP.z + 23.5);
camera.lookAt(LOOK);

const world = createWorld(scene);

const RADIUS = {
  ground: 700,
  grass: 150,
  foliage: 220,
  treesNear: 320,
  treesFar: 700,
};

const streaming = createStreaming();
const ground = createGroundLayer(scene, { radius: RADIUS.ground });
streaming.register(ground.layer);
const grass = createGrass(scene, { radius: RADIUS.grass });
streaming.register(grass.layer);

const trees = createTrees(scene);
streaming.register({ ...trees.layers[0], radius: RADIUS.treesNear });
streaming.register({ ...trees.layers[1], radius: RADIUS.treesFar, size: 350 });

const foliage = createFoliage(scene);
streaming.register({ ...foliage.layer, radius: RADIUS.foliage });

// createStream() owns its own group and animation clock; the newer Cozy Country
// brook keeps HEAD's signature (no scene/world args).
const stream = createStream();
scene.add(stream.group);

const garden = createGarden(scene);
const particles = createParticles(scene, camera);

toonify(scene);
toonifyMaterials([
  ground.material, grass.material, ...trees.materials, ...foliage.materials,
]);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.copy(LOOK);
controls.minDistance = 2;
controls.maxDistance = 260;
controls.maxPolarAngle = Math.PI * 0.56;
controls.update();

const composer = createComposer(renderer, scene, camera);

// ---- Camera viewpoints ----
function makeViewpoint(tCam, latCam, heightCam, tLook, latLook = 0, heightLook = 0.4) {
  const pc = streamCurve.getPointAt(tCam);
  const tc = streamCurve.getTangentAt(tCam);
  const bcx = -tc.z, bcz = tc.x;
  const bcl = Math.hypot(bcx, bcz) || 1;
  const pos = new THREE.Vector3(
    pc.x + (bcx / bcl) * latCam,
    levelAt(tCam) + heightCam,
    pc.z + (bcz / bcl) * latCam
  );

  const pl = streamCurve.getPointAt(tLook);
  const tl = streamCurve.getTangentAt(tLook);
  const blx = -tl.z, blz = tl.x;
  const bll = Math.hypot(blx, blz) || 1;
  const target = new THREE.Vector3(
    pl.x + (blx / bll) * latLook,
    levelAt(tLook) + heightLook,
    pl.z + (blz / bll) * latLook
  );
  return { pos, target };
}

const VIEWPOINTS = {
  lakeside: {
    pos: new THREE.Vector3(camP.x - 2, levelAt(HOME_T) + 7.0, camP.z + 8),
    target: LOOK.clone(),
  },
  bridge: makeViewpoint(
    originalT(0.455),
    -(halfWidthAt(originalT(0.455)) * 0.55),
    3.6,
    originalT(0.498),
    0,
    1.1
  ),
  cascade: makeViewpoint(
    originalT(0.32),
    4.5,
    5.8,
    originalT(0.385),
    0,
    0.5
  ),
  canopy: makeViewpoint(
    originalT(0.39),
    -18,
    24,
    originalT(0.44),
    0,
    1.0
  ),
};

let camAnim = null;
function flyTo(key) {
  const vp = VIEWPOINTS[key];
  if (!vp) return;
  camAnim = {
    startPos: camera.position.clone(),
    endPos: vp.pos.clone(),
    startTarget: controls.target.clone(),
    endTarget: vp.target.clone(),
    t: 0,
    duration: 1.25,
  };
}

// ---- HUD wiring ----
const viewBtns = document.querySelectorAll('[data-view]');
viewBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    viewBtns.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    flyTo(btn.dataset.view);
  });
});

const atmoBtns = document.querySelectorAll('[data-atmo]');
atmoBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    atmoBtns.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    world.setAtmosphere(btn.dataset.atmo);
  });
});


// ---- WASD movement ----
const keys = {};
addEventListener('keydown', (e) => { keys[e.code] = true; });
addEventListener('keyup', (e) => { keys[e.code] = false; });
const UP = new THREE.Vector3(0, 1, 0);
function move(dt) {
  const speed = (keys.ShiftLeft || keys.ShiftRight ? 26 : 13) * dt;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const m = new THREE.Vector3();
  if (keys.KeyW || keys.ArrowUp) m.add(fwd);
  if (keys.KeyS || keys.ArrowDown) m.sub(fwd);
  if (keys.KeyD || keys.ArrowRight) m.add(right);
  if (keys.KeyA || keys.ArrowLeft) m.sub(right);
  if (m.lengthSq() > 0) {
    camAnim = null;
    m.normalize().multiplyScalar(speed);
    camera.position.add(m);
    controls.target.add(m);
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

window.__scene = { scene, camera, renderer, controls, streaming, THREE, world, stream, garden };

let shadowDirty = true;
streaming.onCellLoaded(() => { shadowDirty = true; });
const lastShadowPos = new THREE.Vector3(Infinity, 0, Infinity);
const SHADOW_STEP = 8;

const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (camAnim) {
    camAnim.t += dt;
    const p = Math.min(camAnim.t / camAnim.duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    camera.position.lerpVectors(camAnim.startPos, camAnim.endPos, ease);
    controls.target.lerpVectors(camAnim.startTarget, camAnim.endTarget, ease);
    if (p >= 1) camAnim = null;
  }

  move(dt);
  updateWind(t);
  world.updateAtmosphere(dt, renderer);
  streaming.update(camera);
  world.followSky(camera);
  stream.update(dt);
  garden.update(t, world.getLanternGlow());
  particles.update(dt, t);
  controls.update();
  grass.update(camera);

  if (shadowDirty || lastShadowPos.distanceToSquared(camera.position) > SHADOW_STEP * SHADOW_STEP) {
    lastShadowPos.copy(camera.position);
    world.focusShadow(camera);
    renderer.shadowMap.needsUpdate = true;
    shadowDirty = false;
  }

  composer.render();
  requestAnimationFrame(animate);
}
animate();
