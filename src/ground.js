import * as THREE from 'three';
import { terrainHeight } from './terrain.js';
import { streamAt, levelAt, halfWidthAt } from './streamPath.js';
import { makeGroundTexture } from './textures.js';
import { CELL } from './streaming.js';

// Smooth-shaded valley ground with a tiled mottled-meadow texture. Vertex
// colors tint it: warm wet gravel/moss in the shallow channel, lush mossy grass
// right down to the water's edge, gently varied meadow green elsewhere.

const meadowDeep = new THREE.Color('#4f6e22');
const meadowSun = new THREE.Color('#93ad3e');
export const GRASS_ROOT = 0.55;
const TEX_MEAN = new THREE.Color('#5a682f');

export function meadowColor(x, z, out) {
  const n = 0.5 + 0.5 * Math.sin(x * 0.11 + z * 0.07) * Math.cos(x * 0.05 - z * 0.13);
  const m = 0.5 + 0.5 * Math.sin(x * 0.023 - z * 0.031 + 1.7);
  return out.copy(meadowDeep).lerp(meadowSun, n * 0.5 + m * 0.5);
}

const meadowGround = (x, z, out) => {
  meadowColor(x, z, out);
  out.r *= GRASS_ROOT / TEX_MEAN.r;
  out.g *= GRASS_ROOT / TEX_MEAN.g;
  out.b *= GRASS_ROOT / TEX_MEAN.b;
  return out;
};
const tmp = new THREE.Color();
// Warm olive-grey wet gravel & mossy earth — ZERO blue tint!
const wetGravel = new THREE.Color('#585d48');
const wetMoss = new THREE.Color('#526434');
const lushBank = new THREE.Color('#59702f');

const LOD_STEPS = [
  { within: 250, segments: 74 },
  { within: 450, segments: 36 },
  { within: Infinity, segments: 16 },
];

const segmentsFor = (dist) => LOD_STEPS.find((s) => dist <= s.within).segments;

const OVERLAP = 0.06;

export function createGroundLayer(scene, { radius }) {
  const tex = makeGroundTexture();
  const perUnit = 48 / 300;
  tex.repeat.set(CELL * perUnit, CELL * perUnit);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    vertexColors: true,
    roughness: 1.0,
    metalness: 0.0,
  });

  return {
    material: mat,
    layer: {
      id: 'ground',
      radius,
      lod: segmentsFor,
      build(cell) {
        return buildTile(scene, mat, cell, cell.lod);
      },
      dispose(mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      },
    },
  };
}

function buildTile(scene, mat, cell, seg) {
  const size = cell.size + OVERLAP * 2;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cell.cx;
    const z = pos.getZ(i) + cell.cz;
    const h = terrainHeight(x, z);
    pos.setX(i, x);
    pos.setZ(i, z);
    pos.setY(i, h);

    const { d: sd, t } = streamAt(x, z);
    const lvl = levelAt(t);
    const hw = halfWidthAt(t);
    const dy = h - (lvl - 0.06);
    if (dy < -0.08) {
      c.copy(wetGravel);
    } else if (dy < 0.22) {
      const k = THREE.MathUtils.smoothstep(dy, -0.08, 0.22);
      c.copy(wetGravel).lerp(wetMoss, k);
    } else if (sd < hw + 1.5) {
      const k = THREE.MathUtils.clamp((sd - hw) / 1.5, 0, 1);
      c.copy(lushBank).lerp(meadowGround(x, z, tmp), k * k * (3 - 2 * k));
    } else {
      meadowGround(x, z, c);
    }

    const v = 0.92 + 0.16 * hashNoise(x, z);
    colors[i * 3] = c.r * v;
    colors[i * 3 + 1] = c.g * v;
    colors[i * 3 + 2] = c.b * v;
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function hashNoise(x, z) {
  const q = 0.01;
  const xi = Math.round(x / q) | 0;
  const zi = Math.round(z / q) | 0;
  let h = Math.imul(xi, 0x27d4eb2d) ^ Math.imul(zi, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
