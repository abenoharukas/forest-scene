import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyCanopyWind, keepAuthoredNormals } from './wind.js';
import { cellSeed, withSeed } from './rng.js';
import { terrainHeight, woodlandDensity } from './terrain.js';
import { streamAt, levelAt, halfWidthAt, streamCurve, inWater, HOME_T } from './streamPath.js';
import { makeLeafClumpTexture, makeBarkTexture } from './textures.js';

// Stylized clump-crown woodland covering the entire map with dense groves and
// airy sunlit clearings, keeping the exact vibrant streamside colour palette
// (bright fresh greens, golden-yellow ginkgos, amber-orange & scarlet-red maples,
// with zero dark ink-green crowns) all the way out to the horizon.
//
// NEAR (100m cells, out to 320m) and FAR (350m cells, out to 700m) use strictly
// DISJOINT species sets so near cells never double-spawn and crossing the tier
// boundary never pops trees in or out.
export function createTrees(scene) {
  const pagodaBark = makeBarkTexture({ base: '#aaa294', crack: 'rgba(48,42,34,1)', ridge: 'rgba(222,214,198,1)', knots: false });
  const highBark = makeBarkTexture({ base: '#a3856a', crack: 'rgba(58,44,30,1)', ridge: 'rgba(198,168,130,1)', knots: false });
  const ginkgoBark = makeBarkTexture({ base: '#b09678', crack: 'rgba(52,40,28,1)', ridge: 'rgba(208,188,158,1)', knots: false });
  const mapleBark = makeBarkTexture({ base: '#9a8b7d', crack: 'rgba(46,38,32,1)', ridge: 'rgba(200,188,172,1)' });
  const broadBark = makeBarkTexture({ base: '#9e886f', crack: 'rgba(48,38,28,1)', ridge: 'rgba(192,170,140,1)' });

  // Bright, cheerful sunlit leaf palettes (zero dark ink-green!)
  const highTex = makeLeafClumpTexture(['#5c9246', '#73aa56', '#90c46a'], { leaf: 'needle' });
  const ginkgoTex = makeLeafClumpTexture(['#d9a72c', '#eec244', '#fbdb6d'], { leaf: 'fan' });
  const pagodaTex = makeLeafClumpTexture(['#61964a', '#77ac58', '#8fc46a']);
  const mapleRedTex = makeLeafClumpTexture(['#a8321f', '#c8492a', '#e06a3c'], { leaf: 'maple' });
  const mapleOrangeTex = makeLeafClumpTexture(['#c26a18', '#dd8a26', '#efab45'], { leaf: 'maple' });
  const freshGreenTex = makeLeafClumpTexture(['#589244', '#6fa854', '#8cc369']);

  const SPECIES = {
    // ---- NEAR TIER (100m cells) ----
    pagoda: {
      density: 0.00128, minBank: 3.5, sRange: [0.9, 1.4],
      fixed: [{ x: -27, z: -55.0, s: 1.25 }, { x: -13, z: 18.5, s: 1.35 }],
      trunk: { topR: 0.13, botR: 0.4, h: 11.8, flare: 3.4 },
      bark: pagodaBark,
      tex: pagodaTex,
      crown: {
        crownBase: 3.4, crownTop: 12.4, radius: 3.4,
        profile: 'umbrella',
        hue: 0.27, sat: 0.22, light: 0.91,
      },
    },

    high: {
      density: 0.00090, minBank: 7.0, sRange: [0.9, 1.4],
      trunk: { topR: 0.09, botR: 0.34, h: 14.5, flare: 2.8 },
      bark: highBark,
      tex: highTex,
      crown: {
        crownBase: 2.6, crownTop: 15.8, radius: 2.9,
        profile: 'dome',
        hue: 0.275, sat: 0.22, light: 0.92,
      },
    },

    ginkgo: {
      density: 0.00162, minBank: 3.0, sRange: [0.85, 1.25],
      fixed: [{ x: -32, z: 18.0, s: 1.2 }, { x: -16, z: -54.0, s: 1.15 }],
      trunk: { topR: 0.14, botR: 0.4, h: 8.6, flare: 2.6, bend: 0.4 },
      bark: ginkgoBark,
      tex: ginkgoTex,
      crown: {
        crownBase: 2.6, crownTop: 9.6, radius: 2.7,
        profile: 'dome',
        hue: 0.13, sat: 0.28, light: 0.86, hueVar: 0.03,
      },
    },

    mapleRed: {
      density: 0.00058, minBank: 5.0, warmPocket: true, sRange: [0.85, 1.3],
      trunk: { topR: 0.12, botR: 0.38, h: 10.6, flare: 3.0, bend: 0.25 },
      bark: mapleBark,
      tex: mapleRedTex,
      crown: {
        crownBase: 3.0, crownTop: 11.4, radius: 3.1,
        profile: 'dome',
        hue: 0.035, sat: 0.35, light: 0.83, hueVar: 0.022,
      },
    },

    mapleOrange: {
      density: 0.00074, minBank: 4.2, warmPocket: true, sRange: [0.85, 1.3],
      trunk: { topR: 0.12, botR: 0.36, h: 10.2, flare: 3.0, bend: 0.3 },
      bark: mapleBark,
      tex: mapleOrangeTex,
      crown: {
        crownBase: 2.9, crownTop: 11.0, radius: 3.0,
        profile: 'dome',
        hue: 0.075, sat: 0.33, light: 0.86, hueVar: 0.026,
      },
    },

    // ---- FAR TIER (350m cells out to 700m horizon — same bright green/yellow/orange/red mix!) ----
    farGreen: {
      density: 0.00105, minBank: 8.0, variantsCount: 2, sRange: [0.85, 1.35],
      trunk: { topR: 0.12, botR: 0.40, h: 12.2, flare: 3.0 },
      bark: broadBark,
      tex: freshGreenTex,
      crown: {
        crownBase: 3.1, crownTop: 13.4, radius: 3.2,
        profile: 'dome',
        hue: 0.275, sat: 0.23, light: 0.90, hueVar: 0.065,
      },
    },

    farGold: {
      density: 0.00068, minBank: 6.0, variantsCount: 2, sRange: [0.85, 1.3],
      trunk: { topR: 0.13, botR: 0.38, h: 9.4, flare: 2.6, bend: 0.35 },
      bark: ginkgoBark,
      tex: ginkgoTex,
      crown: {
        crownBase: 2.7, crownTop: 10.2, radius: 2.8,
        profile: 'dome',
        hue: 0.13, sat: 0.28, light: 0.86, hueVar: 0.03,
      },
    },

    farOrange: {
      density: 0.00036, minBank: 6.5, warmPocket: true, variantsCount: 2, sRange: [0.85, 1.3],
      trunk: { topR: 0.12, botR: 0.36, h: 10.4, flare: 3.0, bend: 0.28 },
      bark: mapleBark,
      tex: mapleOrangeTex,
      crown: {
        crownBase: 2.9, crownTop: 11.2, radius: 3.0,
        profile: 'dome',
        hue: 0.075, sat: 0.33, light: 0.86, hueVar: 0.026,
      },
    },

    farRed: {
      density: 0.00028, minBank: 7.5, warmPocket: true, variantsCount: 2, sRange: [0.85, 1.3],
      trunk: { topR: 0.12, botR: 0.38, h: 10.8, flare: 3.0, bend: 0.24 },
      bark: mapleBark,
      tex: mapleRedTex,
      crown: {
        crownBase: 3.0, crownTop: 11.5, radius: 3.1,
        profile: 'dome',
        hue: 0.035, sat: 0.35, light: 0.83, hueVar: 0.022,
      },
    },
  };

  for (const s of Object.values(SPECIES)) {
    const c = s.crown;
    s.trunk.h = Math.min(s.trunk.h, c.crownBase + 0.65 * (c.crownTop - c.crownBase));
    s.trunkGeo = makeTrunkGeo(s.trunk);
    s.trunkMat = new THREE.MeshStandardMaterial({ map: s.bark, roughness: 0.95, metalness: 0 });
    Object.assign(s, makeCanopyAssets(s.tex, s.crown, s.variantsCount ?? 3));
  }

  const NEAR = ['pagoda', 'high', 'ginkgo', 'mapleRed', 'mapleOrange'];
  const FAR = ['farGreen', 'farGold', 'farOrange', 'farRed'];
  const materials = [];
  for (const s of Object.values(SPECIES)) {
    materials.push(s.trunkMat, s.canopyMat);
  }

  return {
    materials,
    layers: [
      makeTreeLayer(scene, SPECIES, NEAR, 'treesNear'),
      makeTreeLayer(scene, SPECIES, FAR, 'treesFar'),
    ],
  };
}

function makeTreeLayer(scene, SPECIES, names, id) {
  return {
    id,
    build(cell) {
      const meshes = [];
      for (let k = 0; k < names.length; k++) {
        const s = SPECIES[names[k]];
        withSeed(cellSeed(cell.i, cell.j, k * 977 + 31), () => {
          const trees = placeInCell(s, cell);
          if (!trees.length) return;
          addTrunks(scene, meshes, trees, s);
          addCanopy(scene, meshes, trees, s);
        });
      }
      return meshes;
    },
    dispose(meshes) {
      for (const m of meshes) {
        scene.remove(m);
        m.dispose();
      }
    },
  };
}

const TREE_SCALE = 2;

function placeInCell(s, cell) {
  const { density, minBank, warmPocket, sRange, fixed } = s;
  const trees = [];
  const size = cell.size;
  const x0 = cell.cx - size / 2;
  const z0 = cell.cz - size / 2;

  if (fixed) {
    for (const f of fixed) {
      if (f.x < x0 || f.x >= x0 + size || f.z < z0 || f.z >= z0 + size) continue;
      if (inWater(f.x, f.z, 1.6)) continue;
      trees.push({ x: f.x, z: f.z, rot: Math.random() * Math.PI * 2, s: f.s * TREE_SCALE });
    }
  }

  const camP = streamCurve.getPointAt(HOME_T);
  const camX = camP.x - 5.5, camZ = camP.z + 23.5;

  const want = density * 1.15 * size * size;
  const attempts = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);

  for (let a = 0; a < attempts; a++) {
    const x = x0 + Math.random() * size;
    const z = z0 + Math.random() * size;
    if ((x - camX) * (x - camX) + (z - camZ) * (z - camZ) < 16 * 16) continue;
    const { d: sd, t } = streamAt(x, z);
    const bankDist = sd - halfWidthAt(t);
    if (bankDist < minBank) continue;

    // Multi-scale grove/glade modulation: dense stands (~1.3) vs airy clearings (~0.28)
    const grove = woodlandDensity(x, z);
    const bankRamp = THREE.MathUtils.clamp((bankDist - minBank) / 14 + 0.52, 0, 1);
    let keep = bankRamp * THREE.MathUtils.clamp(grove * 0.80, 0.24, 1.0);

    if (warmPocket) {
      const pocket = 0.78 + 0.22 * Math.sin(x * 0.031 - z * 0.027 + 1.9);
      keep *= pocket;
    }

    if (Math.random() > keep) continue;
    const h = terrainHeight(x, z);
    if (h < levelAt(t) + 0.5) continue;
    if (inWater(x, z, 1.6)) continue;
    trees.push({
      x, z,
      rot: Math.random() * Math.PI * 2,
      s: (sRange[0] + Math.random() * (sRange[1] - sRange[0])) * TREE_SCALE,
    });
  }
  return trees;
}

function makeTrunkGeo({ topR, botR, h, flare = 3.5, bend = 0 }) {
  const g = new THREE.CylinderGeometry(topR, botR, h, 14, 10, true);
  g.translate(0, h / 2, 0);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const dir = Math.random() * Math.PI * 2;
  const bx = Math.cos(dir) * bend, bz = Math.sin(dir) * bend;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = v.y / h;
    const ang = Math.atan2(v.z, v.x);
    const lump = 1 + (Math.sin(ang * 3 + v.y * 0.8) * 0.5 + Math.sin(ang * 5 + 1.7 + v.y * 0.35) * 0.5) * 0.07;
    const fl = t < 0.08 ? 1 + (0.08 - t) * flare * (0.55 + 0.45 * Math.sin(ang * 5 + 1.3)) : 1;
    const tip = t > 0.82 ? Math.max(0, (1 - t) / 0.18) : 1;
    pos.setX(i, v.x * lump * fl * tip + bx * t * t);
    pos.setZ(i, v.z * lump * fl * tip + bz * t * t);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function addTrunks(scene, out, trees, s) {
  const mesh = new THREE.InstancedMesh(s.trunkGeo, s.trunkMat, trees.length);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  const dummy = new THREE.Object3D();
  trees.forEach((tr, i) => {
    dummy.position.set(tr.x, terrainHeight(tr.x, tr.z) - 0.25, tr.z);
    dummy.rotation.set((Math.random() - 0.5) * 0.07, tr.rot, (Math.random() - 0.5) * 0.07);
    dummy.scale.set(tr.s, tr.s, tr.s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
  out.push(mesh);
}

const smoothstep = (e0, e1, x) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const CROWN_PROFILES = {
  dome: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.8),
  umbrella: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.55),
};

function makeClumpCrownGeo(p) {
  const profile = CROWN_PROFILES[p.profile];
  const R = p.radius, H = p.crownTop - p.crownBase;
  const cy = H * 0.55;
  const lumps = [];

  const STEPS = 64;
  const cdf = [0];
  for (let i = 1; i <= STEPS; i++) cdf.push(cdf[i - 1] + profile(i / STEPS));
  const umbrella = p.profile === 'umbrella';
  const n = Math.round((umbrella ? 16 : 13) * Math.max(1, H / R / 2.7));
  const lr = R * (umbrella ? 0.46 : 0.44);
  for (let k = 0; k < n; k++) {
    const target = ((k + 0.5) / n) * cdf[STEPS];
    let i = 1;
    while (cdf[i] < target) i++;
    const t = THREE.MathUtils.clamp(i / STEPS, 0.14, 0.9);
    const ring = profile(t) * R * 0.66;
    const a = k * 2.39996 + Math.random() * 0.5;
    lumps.push({ x: Math.cos(a) * ring, y: t * H, z: Math.sin(a) * ring, r: lr * (0.85 + Math.random() * 0.3), sy: umbrella ? 0.7 : 0.9 });
  }
  lumps.push({ x: 0, y: H * 0.86, z: 0, r: lr * 0.95, sy: 0.8 });
  const cores = Math.max(1, Math.round(H / (R * 1.6)));
  for (let k = 0; k < cores; k++) {
    const y = cores === 1 ? cy : H * (0.22 + 0.6 * (k / (cores - 1)));
    lumps.push({ x: 0, y, z: 0, r: R * 0.55, sy: 0.8, core: true });
  }

  const pos = [], nrm = [], col = [], uvs = [], card = [], idx = [];
  const c = new THREE.Vector3(), v = new THREE.Vector3(), d = new THREE.Vector3();
  const out = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  let maxHalf = 0;

  for (const L of lumps) {
    c.set(L.x, L.y, L.z);
    out.set(L.x, (L.y - cy) * 0.6, L.z);
    if (out.lengthSq() < 1e-4) out.set(0, 1, 0);
    out.normalize();
    const M = L.core ? 14 : Math.max(7, Math.round(16 * (L.r / (R * 0.44)) ** 2));
    for (let m = 0; m < M; m++) {
      d.randomDirection();
      if (!L.core) d.addScaledVector(out, 0.9).normalize();
      const rr = L.r * (0.45 + Math.random() * 0.45);
      v.set(L.x + d.x * rr, L.y + d.y * rr * L.sy, L.z + d.z * rr);
      const half = L.r * (0.4 + Math.random() * 0.22);
      maxHalf = Math.max(maxHalf, half);

      n2.set(v.x / R, (v.y - cy) / (H * 0.5), v.z / R);
      const q = n2.length();
      n2.normalize();
      if (L.core) n1.copy(n2);
      else n1.subVectors(v, c).normalize().add(n2).multiplyScalar(0.5);
      n1.y += 0.2;
      n1.normalize();

      let ao = (0.42 + 0.58 * smoothstep(0.25, 0.95, q)) * (0.64 + 0.36 * THREE.MathUtils.clamp(v.y / H, 0, 1));
      if (d.dot(out) < 0) ao *= 0.85;
      if (L.core) ao *= 0.7;
      const rot = Math.random() * Math.PI * 2;

      const base = pos.length / 3;
      for (const [cx, cz] of CORNERS) {
        pos.push(v.x, v.y, v.z);
        nrm.push(n1.x, n1.y, n1.z);
        col.push(ao, ao, ao);
        uvs.push((cx + 1) / 2, (cz + 1) / 2);
        card.push(cx, cz, half, rot);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aCard', new THREE.Float32BufferAttribute(card, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.boundingSphere.radius += maxHalf;
  return g;
}

function applyBillboard(material) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.vertexShader = 'attribute vec4 aCard;\nvarying vec2 vCorner;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float cr = cos(aCard.w), sr = sin(aCard.w);
         vCorner = vec2(aCard.x * cr - aCard.y * sr, aCard.x * sr + aCard.y * cr);
         vec2 cc = vCorner * aCard.z;
         vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
         vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
         mat3 im = mat3(instanceMatrix);
         transformed += transpose(im) * (camR * cc.x + camU * cc.y) / length(im[0]);
       }`
    );
    shader.fragmentShader = 'varying vec2 vCorner;\n' + shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
       normal = normalize(normal + vec3(vCorner * 0.55, 0.0));`
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       {
         vec2 tx = vMapUv * vec2(textureSize(map, 0));
         vec2 ddx = dFdx(tx), ddy = dFdy(tx);
         float lod = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
         diffuseColor.a *= 1.0 + lod * 0.3;
       }`
    );
  };
  material.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) : '') + '-billboard';
  };
  return material;
}

function makeCanopyAssets(tex, p, count = 3) {
  const variants = Array.from({ length: count }, () => makeClumpCrownGeo(p));
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    alphaMap: tex.alphaMap,
    vertexColors: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
  });
  applyCanopyWind(mat, { strength: 0.13, freq: 1.1 });
  keepAuthoredNormals(mat);
  applyBillboard(mat);
  mat.userData.canopy = true;
  const depthMat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: tex.map,
    alphaMap: tex.alphaMap,
    alphaTest: 0.5,
  });
  applyBillboard(depthMat);

  return { crownVariants: variants, canopyMat: mat, canopyDepthMat: depthMat };
}

function addCanopy(scene, out, trees, s) {
  const p = s.crown;
  const variants = s.crownVariants;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const groups = variants.map(() => ({ mats: [], cols: [] }));

  trees.forEach((tr, i) => {
    const g = groups[i % variants.length];
    const yBase = terrainHeight(tr.x, tr.z);
    dummy.position.set(tr.x, yBase + p.crownBase * tr.s, tr.z);
    dummy.rotation.set(0, tr.rot + Math.random() * Math.PI * 2, 0);
    const k = tr.s * (0.9 + Math.random() * 0.2);
    dummy.scale.set(k, k, k);
    dummy.updateMatrix();
    g.mats.push(dummy.matrix.clone());
    col.setHSL(
      p.hue + (Math.random() - 0.5) * (p.hueVar ?? 0.065),
      (p.sat ?? 0.24) + (Math.random() - 0.5) * 0.09,
      p.light + (Math.random() - 0.5) * 0.08
    );
    g.cols.push(col.clone());
  });

  variants.forEach((geo, i) => {
    const { mats, cols } = groups[i];
    if (!mats.length) return;
    const mesh = new THREE.InstancedMesh(geo, s.canopyMat, mats.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.customDepthMaterial = s.canopyDepthMat;
    for (let k = 0; k < mats.length; k++) {
      mesh.setMatrixAt(k, mats[k]);
      mesh.setColorAt(k, cols[k]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    out.push(mesh);
  });
}

export function makeBlobGeo() {
  const raw = new THREE.IcosahedronGeometry(0.55, 2);
  raw.deleteAttribute('uv');
  const g = mergeVertices(raw);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 4.2 + 9 + v.y * 4.2 + v.z * 3.2) * 0.5 + Math.sin(v.y * 7.5 + v.x * 5.5) * 0.5;
    const f = 1 + n * 0.34;
    pos.setXYZ(i, v.x * f, v.y * f * 0.82, v.z * f);
    uvs[i * 2] = Math.atan2(v.z, v.x) / (Math.PI * 2) + 0.5;
    uvs[i * 2 + 1] = v.y / 1.1 + 0.5;
  }
  pos.needsUpdate = true;
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}
