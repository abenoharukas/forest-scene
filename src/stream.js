import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  streamCurve, levelAt, cascadeAt, halfWidthAt, narrownessAt, DROPS, DROP_LEN,
  STREAM_LENGTH, tOfArc, tSpan, originalT,
} from './streamPath.js';
import { terrainHeight } from './terrain.js';
import { makeRockTexture, makeBedTexture } from './textures.js';
import { withSeed } from './rng.js';

// Stylized painterly forest stream inspired by Cozy Country / Ghibli / BotW:
//   - Crystal-clear celadon-aqua shallows revealing sunlit river cobbles and
//     dancing underwater caustics, deepening into vibrant emerald-teal runs
//     and rich cerulean-jade pools.
//   - Analytic wave normals driving stylized sky + overhanging-canopy Fresnel
//     reflections and crisp toon-stepped sun glints.
//   - Four-layer graphic cartoon foam (organic terrain-hugging shoreline lace,
//     sinuous current ribbons, sculpted two-tone waterfall froth + plunge-pool
//     ripples, and animated V-shaped boulder wakes flush with the surface).
//   - Smooth river-worn boulders with mossy caps, wet dark waterlines, and
//     underwater teal absorption.

const WATER_Y_OFFSET = -0.08;
const waterSurfaceAt = (t) => levelAt(t) + WATER_Y_OFFSET;

const ORIGINAL_LENGTH = 326.409;
const LENGTH_RATIO = STREAM_LENGTH / ORIGINAL_LENGTH;
const perLength = (authored) => Math.round(authored * LENGTH_RATIO);

// Sun direction matches world.js (60, 92, -120) normalized.
const SUN_DIR = new THREE.Vector3(60, 92, -120).normalize();

function bedDepth(cross) {
  return 0.42 + 1.18 * (1 - cross * cross);
}

// Plunge-pool zone immediately downstream (smaller arc u) of each drop foot:
// returns { strength: 0..1, phase: 0..1 (0 at waterfall foot -> 1 downstream) }.
function plungeInfoAt(t) {
  const u = t * STREAM_LENGTH;
  let bestS = 0;
  let bestP = 0;
  for (const d of DROPS) {
    // Drop ramp ends at d.u - 0.5 * DROP_LEN; plunge pool stretches ~3.6 DROP_LEN downstream
    const distBelow = (d.u - 0.35 * DROP_LEN) - u;
    const span = DROP_LEN * 3.6;
    if (distBelow >= 0 && distBelow <= span) {
      const p = distBelow / span;
      const s = (1 - p) * (1 - p * 0.45);
      if (s > bestS) {
        bestS = s;
        bestP = p;
      }
    }
  }
  return { strength: bestS, phase: bestP };
}

// Shared GLSL noise & cellular helpers (pure ALU, wrapped inputs for infinite uTime precision).
const GLSL_WATER_NOISE = /* glsl */ `
  float wHash21(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794) + vec2(0.1, 0.17));
    p *= 17.0;
    return fract(p.x * p.y * (p.x + p.y));
  }

  vec2 wHash22(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794) + vec2(0.11, 0.17));
    p += dot(p, p.yx + 19.19);
    return fract((p.xx + p.yx) * p.xy);
  }

  // Quintic value noise + analytical partial derivatives: vec3(val, ddx, ddy)
  vec3 wNoiseGrad(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    float a = wHash21(i);
    float b = wHash21(i + vec2(1.0, 0.0));
    float c = wHash21(i + vec2(0.0, 1.0));
    float d = wHash21(i + vec2(1.0, 1.0));
    float k0 = a;
    float k1 = b - a;
    float k2 = c - a;
    float k3 = a - b - c + d;
    return vec3(
      k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
      du.x * (k1 + k3 * u.y),
      du.y * (k2 + k3 * u.x)
    );
  }

  // Stylized Voronoi distances: vec2(nearest F1, second-nearest F2)
  // F2 - F1 produces crisp cartoon caustic / foam lace webs; F1 gives bubbly droplets.
  vec2 wCellular(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = wHash22(n + g);
        vec2 r = g + (0.16 + 0.68 * o) - f;
        float d = dot(r, r);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return vec2(sqrt(f1), sqrt(f2));
  }

  // Extract sun shadow mask (0 in cast tree shadow -> 1 in direct sun) from
  // Three.js's accumulated lighting, matching toon.js's exact terminator ratio.
  float wSunShadow(ReflectedLight rl) {
    float dl = dot(rl.directDiffuse, vec3(0.2126, 0.7152, 0.0722));
    float il = dot(rl.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722));
    return smoothstep(0.11, 0.30, dl / (dl + il + 1e-4));
  }
`;

export function createStream() {
  return withSeed(20250615, () => {
    const group = new THREE.Group();
    const uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR.clone() },
    };

    group.add(buildBedRibbon(uniforms));

    const water = buildWaterRibbon(uniforms);
    group.add(water.mesh);

    const rockTex = makeRockTexture();
    const rockMat = makeStylizedRockMaterial(rockTex);
    const variants = [buildRockGeo(0), buildRockGeo(1), buildRockGeo(2)];
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();

    // Collect rock instances per variant so all boulders draw in just 3 calls
    // with per-instance local water elevation (aWaterY) for wet rims + moss caps.
    const rockBuckets = variants.map(() => []);
    const foamRings = [];

    const addRing = (x, z, t, radius) => {
      const tc = THREE.MathUtils.clamp(t, 0, 1);
      const tan = streamCurve.getTangentAt(tc);
      const dl = Math.hypot(tan.x, tan.z) || 1;
      // t=1 is upstream -> -tangent points downstream
      foamRings.push({
        x,
        z,
        y: waterSurfaceAt(tc) + 0.014,
        r: radius,
        dx: -tan.x / dl,
        dz: -tan.z / dl,
        phase: Math.random() * 10.0,
      });
    };

    const pushRock = (vIdx, cx, y, cz, sx, sy, sz, rx, ry, rz, hsl, waterY) => {
      dummy.position.set(cx, y, cz);
      dummy.rotation.set(rx, ry, rz);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      col.setHSL(hsl[0], hsl[1], hsl[2]);
      rockBuckets[vIdx].push({
        matrix: dummy.matrix.clone(),
        color: col.clone(),
        waterY,
      });
    };

    const addBoulder = (vIdx, cx, cz, y, s, waterY, { flat = false } = {}) => {
      const sx = s * (0.88 + Math.random() * 0.36);
      const sy = s * (flat ? 0.38 + Math.random() * 0.24 : 0.56 + Math.random() * 0.34);
      const sz = s * (0.88 + Math.random() * 0.36);
      const rx = (Math.random() - 0.5) * (flat ? 0.28 : 0.7);
      const ry = Math.random() * Math.PI * 2;
      const rz = (Math.random() - 0.5) * (flat ? 0.28 : 0.7);
      // Warm cream-ochre to soft cool river-grey stone variation (like Cozy Country)
      const hue = 0.08 + (Math.random() - 0.5) * 0.04;
      const sat = 0.08 + Math.random() * 0.10;
      const light = 0.62 + Math.random() * 0.18;
      pushRock(vIdx, cx, y, cz, sx, sy, sz, rx, ry, rz, [hue, sat, light], waterY);
      return sy;
    };

    const lateral = (t, lat) => {
      const tc = THREE.MathUtils.clamp(t, 0, 1);
      const p = streamCurve.getPointAt(tc);
      const tan = streamCurve.getTangentAt(tc);
      const bx = -tan.z, bz = tan.x;
      const bl = Math.hypot(bx, bz) || 1;
      return { x: p.x + (bx / bl) * lat, z: p.z + (bz / bl) * lat };
    };

    // Find actual terrain shoreline offset on `side` (-1 or +1) at curve parameter t
    const findShoreline = (t, side) => {
      const tc = THREE.MathUtils.clamp(t, 0, 1);
      const p = streamCurve.getPointAt(tc);
      const tan = streamCurve.getTangentAt(tc);
      const bx = -tan.z, bz = tan.x;
      const bl = Math.hypot(bx, bz) || 1;
      const wy = waterSurfaceAt(tc);
      const hw = halfWidthAt(tc);
      for (let off = Math.max(1.2, hw - 1.8); off < hw + 5.5; off += 0.3) {
        const x = p.x + (bx / bl) * off * side;
        const z = p.z + (bz / bl) * off * side;
        if (terrainHeight(x, z) >= wy - 0.02) {
          return { x, z, off, wy };
        }
      }
      return null;
    };

    // ---- 1. Stone sills framing every cascade lip ----
    {
      const perDrop = 7;
      const SILL_JITTER = tSpan(1.3);
      for (const d of DROPS) {
        const tLip = tOfArc(d.u + DROP_LEN * 0.38);
        const hw = halfWidthAt(tLip);
        const tFoot = tOfArc(d.u + DROP_LEN * 0.85);
        const wy = waterSurfaceAt(tLip);
        for (let k = 0; k < perDrop; k++) {
          const lat = ((k + 0.5) / perDrop - 0.5) * 2 * (hw * 0.92) + (Math.random() - 0.5) * 1.1;
          const tt = THREE.MathUtils.clamp(tLip + (Math.random() - 0.5) * SILL_JITTER, 0, 1);
          const { x, z } = lateral(tt, lat);
          const s = 0.85 + Math.random() * 1.05;
          const vIdx = (k + ((Math.random() * 3) | 0)) % 3;
          addBoulder(vIdx, x, z, wy - 0.38 + s * 0.24, s, wy);
          addRing(x, z, tFoot, s * 1.35);
        }
      }
    }

    // ---- 2. Clustered shoreline cobbles & mossy bank boulders (Cozy Country bank framing) ----
    {
      const CLUSTERS = perLength(78);
      for (let c = 0; c < CLUSTERS; c++) {
        const tt = Math.random();
        const side = Math.random() < 0.5 ? 1 : -1;
        const shore = findShoreline(tt, side);
        if (!shore) continue;
        const stonesInCluster = 2 + ((Math.random() * 4) | 0);
        for (let k = 0; k < stonesInCluster; k++) {
          const dt = tSpan((Math.random() - 0.5) * 3.4);
          const tk = THREE.MathUtils.clamp(tt + dt, 0, 1);
          const sh = k === 0 ? shore : findShoreline(tk, side);
          if (!sh) continue;
          const inOut = (Math.random() - 0.42) * 1.35; // straddling water & grassy bank
          const { x, z } = lateral(tk, (sh.off + inOut) * side);
          const s = k === 0 ? 0.75 + Math.random() * 0.95 : 0.35 + Math.random() * 0.65;
          const th = terrainHeight(x, z);
          const wy = waterSurfaceAt(tk);
          const y = Math.max(th - s * 0.18, wy - s * 0.42);
          const sy = addBoulder((c + k) % 3, x, z, y, s, wy, { flat: Math.random() < 0.55 });
          if (inOut < -0.15 && y + sy > wy + 0.06 && y - sy < wy) {
            addRing(x, z, tk, s * 1.25);
          }
        }
      }
    }

    // ---- 3. Scattered larger bank boulders + emergent stream stones ----
    {
      const bankCount = perLength(28);
      for (let i = 0; i < bankCount; i++) {
        const tt = Math.random();
        const hw = halfWidthAt(tt);
        const side = Math.random() < 0.5 ? 1 : -1;
        const lat = (hw + 1.0 + Math.random() * 4.2) * side;
        const { x, z } = lateral(tt, lat);
        const s = 0.85 + Math.random() * 1.65;
        const wy = waterSurfaceAt(tt);
        const y = terrainHeight(x, z) + s * 0.12;
        addBoulder(i % 3, x, z, y, s, wy);
      }

      const streamCount = perLength(56);
      for (let i = 0; i < streamCount; i++) {
        const tt = Math.random();
        const hw = halfWidthAt(tt);
        const lat = (Math.random() - 0.5) * 2 * Math.max(1.0, hw - 0.8);
        const { x, z } = lateral(tt, lat);
        const s = 0.35 + Math.random() * 0.82;
        const wy = waterSurfaceAt(tt);
        const cross = Math.min(1, Math.abs(lat) / (hw + 1.2));
        const bedY = levelAt(tt) - bedDepth(cross);
        const y = Math.max(bedY + s * 0.45, wy - 0.55 + s * 0.36);
        const sy = addBoulder(i % 3, x, z, y, s, wy, { flat: true });
        if (y + sy * 0.85 > wy + 0.04 && y - sy < wy) {
          addRing(x, z, tt, s * 1.45);
        }
      }
    }

    // ---- 4. Hand-placed hero boulders in the opening view ----
    {
      const hero = [
        { t: originalT(0.405), lat: -3.5, s: 1.85 },
        { t: originalT(0.418), lat: 1.5, s: 1.38 },
        { t: originalT(0.432), lat: 4.5, s: 2.2 },
        { t: originalT(0.445), lat: -1.0, s: 1.08 },
        { t: originalT(0.458), lat: -5.0, s: 1.55 },
      ];
      hero.forEach((hr, i) => {
        const { x, z } = lateral(hr.t, hr.lat);
        const wy = waterSurfaceAt(hr.t);
        addBoulder((i + 1) % 3, x, z, wy - 0.52 + hr.s * 0.36, hr.s, wy);
        addRing(x, z, hr.t, hr.s * 1.55);
      });
    }

    // Build the 3 consolidated boulder InstancedMeshes
    variants.forEach((baseGeo, vIdx) => {
      const list = rockBuckets[vIdx];
      if (!list.length) return;
      const geo = baseGeo.clone();
      const waterYArr = new Float32Array(list.length);
      const mesh = new THREE.InstancedMesh(geo, rockMat, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < list.length; i++) {
        mesh.setMatrixAt(i, list[i].matrix);
        mesh.setColorAt(i, list[i].color);
        waterYArr[i] = list[i].waterY;
      }
      geo.setAttribute('aWaterY', new THREE.InstancedBufferAttribute(waterYArr, 1));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    });

    // ---- 5. Submerged riverbed pebbles (tinted & lit with underwater caustics) ----
    group.add(buildSubmergedPebbles(buildRockGeo(3, 2), rockTex, uniforms, lateral));

    // ---- 6. Animated cartoon foam wakes flush on the water surface ----
    if (foamRings.length) {
      group.add(buildWakeMesh(foamRings, uniforms));
    }

    return {
      group,
      update(dt) {
        uniforms.uTime.value += dt;
      },
    };
  });
}

// Smooth river-worn boulders: merge vertices BEFORE displacing so normals
// interpolate smoothly across stone planes instead of faceting into golf balls.
function buildRockGeo(seedIdx, detail = 3) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute('uv');
  const g = mergeVertices(raw);
  const pos = g.attributes.position;
  const uvs = new Float32Array(pos.count * 2);

  const f1 = 1.35 + seedIdx * 0.42 + Math.random() * 0.5;
  const f2 = 2.1 + seedIdx * 0.55 + Math.random() * 0.7;
  const ph1 = Math.random() * 6.28;
  const ph2 = Math.random() * 6.28;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Gentle river-rounded lobes + slightly flatter river-worn underside/top
    const n1 = Math.sin(x * f1 + ph1) * Math.cos(z * f1 * 0.9 + ph2);
    const n2 = Math.sin(y * f2 + z * 1.4 + ph1) * 0.5 + Math.cos(x * f2 * 0.8 - y * 1.3) * 0.5;
    const flatten = y < 0 ? 0.78 : 0.92;
    const r = 1.0 + n1 * 0.14 + n2 * 0.07;
    const nx = x * r;
    const ny = y * r * flatten;
    const nz = z * r;
    pos.setXYZ(i, nx, ny, nz);

    uvs[i * 2] = Math.atan2(nz, nx) / (Math.PI * 2) + 0.5;
    uvs[i * 2 + 1] = ny * 0.5 + 0.5;
  }
  pos.needsUpdate = true;
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

// Boulders participate in toon.js cel-shading for warm sunlit tops & cool
// sky-blue shadows, enhanced with mossy caps, wet dark waterlines, and
// turquoise underwater absorption below the stream surface.
function makeStylizedRockMaterial(rockTex) {
  const mat = new THREE.MeshStandardMaterial({
    map: rockTex,
    roughness: 0.95,
    metalness: 0.0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute float aWaterY;
      varying vec3 vRockWPos;
      varying vec3 vRockWNrm;
      varying float vRockWaterY;
    ` + shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         {
           mat3 rIm = mat3(1.0);
           #ifdef USE_INSTANCING
             rIm = mat3(instanceMatrix);
           #endif
           vRockWNrm = normalize(mat3(modelMatrix) * rIm * objectNormal);
         }`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 rWp = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             rWp = instanceMatrix * rWp;
           #endif
           rWp = modelMatrix * rWp;
           vRockWPos = rWp.xyz;
           vRockWaterY = aWaterY;
         }`
      );

    shader.fragmentShader = `
      varying vec3 vRockWPos;
      varying vec3 vRockWNrm;
      varying float vRockWaterY;
    ` + shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float dy = vRockWPos.y - vRockWaterY;
          // Organic moss cap on upward-facing dry boulder tops (like Cozy Country)
          float mossPatch = 0.5 + 0.5 * sin(vRockWPos.x * 1.3 + vRockWPos.z * 1.1) * cos(vRockWPos.z * 1.7 - vRockWPos.x * 0.8);
          float mossMask = smoothstep(0.56, 0.80, vRockWNrm.y + mossPatch * 0.18 - 0.08)
                         * smoothstep(0.14, 0.36, dy);
          vec3 mossCol = vec3(0.30, 0.47, 0.16);
          diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, mossMask * 0.72);

          // Darkened wet river-stone band right where water laps the rock
          float wetBand = 1.0 - smoothstep(-0.02, 0.26, dy);
          diffuseColor.rgb *= mix(1.0, 0.54, wetBand);
        }`
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          float subDepth = max(0.0, vRockWaterY - vRockWPos.y);
          if (subDepth > 0.0) {
            float absorb = 1.0 - exp(-subDepth * 2.2);
            vec3 aquaTint = vec3(0.03, 0.21, 0.23);
            outgoingLight = mix(outgoingLight * 0.78, aquaTint, absorb * 0.86);
          }
        }
        #include <opaque_fragment>`
      );
  };
  mat.customProgramCacheKey = () => 'stylized-river-rock';
  return mat;
}

// Submerged pebbles on the streambed: skip dry cel rim-light and instead apply
// real water-column teal absorption + animated sunlit caustics so they read as
// lying UNDER clear water rather than floating in air.
function buildSubmergedPebbles(baseGeo, rockTex, uniforms, lateral) {
  const COUNT = perLength(460);
  const geo = baseGeo.clone();
  const depthArr = new Float32Array(COUNT);

  const mat = new THREE.MeshStandardMaterial({
    map: rockTex,
    roughness: 1.0,
    metalness: 0.0,
  });
  mat.userData.skipToon = true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = `
      attribute float aSubDepth;
      varying vec3 vPebWPos;
      varying vec3 vPebWNrm;
      varying float vSubDepth;
    ` + shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         {
           mat3 pIm = mat3(1.0);
           #ifdef USE_INSTANCING
             pIm = mat3(instanceMatrix);
           #endif
           vPebWNrm = normalize(mat3(modelMatrix) * pIm * objectNormal);
         }`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 pWp = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             pWp = instanceMatrix * pWp;
           #endif
           pWp = modelMatrix * pWp;
           vPebWPos = pWp.xyz;
           vSubDepth = aSubDepth;
         }`
      );

    shader.fragmentShader = `
      uniform float uTime;
      varying vec3 vPebWPos;
      varying vec3 vPebWNrm;
      varying float vSubDepth;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_WATER_NOISE}`)
      .replace(
      '#include <opaque_fragment>',
      `{
        float shadow = wSunShadow(reflectedLight);
        float tWrap = mod(uTime, 3600.0);
        float upFace = clamp(vPebWNrm.y * 0.5 + 0.5, 0.0, 1.0);

        // Two-tone underwater stone shading
        vec3 base = diffuseColor.rgb;
        vec3 litStone = base * mix(vec3(0.42, 0.56, 0.62), vec3(0.95, 0.92, 0.78), shadow * upFace);

        // Sunlit underwater caustic web dancing across shallow pebbles
        vec2 cUv = vPebWPos.xz * 0.72 + vec2(tWrap * 0.55, -tWrap * 0.38);
        vec2 cell = wCellular(cUv);
        float caust = (1.0 - smoothstep(0.03, 0.19, cell.y - cell.x)) * shadow * max(vPebWNrm.y, 0.0);
        float shallowVis = exp(-vSubDepth * 1.15);
        litStone += vec3(0.26, 0.44, 0.38) * caust * shallowVis;

        // Water-column turquoise absorption with depth
        vec3 deepTint = mix(vec3(0.018, 0.13, 0.18), vec3(0.035, 0.23, 0.25), shadow);
        float absorb = 1.0 - exp(-vSubDepth * 1.35);
        outgoingLight = mix(litStone, deepTint, absorb * 0.84);
      }
      #include <opaque_fragment>`
    );
  };
  mat.customProgramCacheKey = () => 'submerged-pebbles';

  const pebbles = new THREE.InstancedMesh(geo, mat, COUNT);
  pebbles.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  for (let i = 0; i < COUNT; i++) {
    const tt = Math.random();
    const hw = halfWidthAt(tt);
    // Bias more pebbles toward the clearer shallow edges where they sparkle
    const uRand = Math.random() * 2 - 1;
    const latNorm = Math.sign(uRand) * Math.pow(Math.abs(uRand), 0.72);
    const lat = latNorm * (hw - 0.35);
    const { x, z } = lateral(tt, lat);
    const s = 0.16 + Math.random() * 0.46;
    const cross = Math.min(1, Math.abs(lat) / (hw + 1.2));
    const y = levelAt(tt) - bedDepth(cross) + s * 0.28;
    const wy = waterSurfaceAt(tt);

    dummy.position.set(x, y, z);
    dummy.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5);
    dummy.scale.set(s * (0.9 + Math.random() * 0.35), s * (0.42 + Math.random() * 0.26), s * (0.9 + Math.random() * 0.35));
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);

    const tone = Math.random();
    if (tone < 0.35) col.setHSL(0.10, 0.16, 0.56 + Math.random() * 0.16); // warm golden ochre
    else if (tone < 0.7) col.setHSL(0.46, 0.10, 0.44 + Math.random() * 0.14); // cool river slate
    else col.setHSL(0.24, 0.18, 0.42 + Math.random() * 0.14); // mossy olive stone
    pebbles.setColorAt(i, col);

    depthArr[i] = Math.max(0.05, wy - y);
  }

  geo.setAttribute('aSubDepth', new THREE.InstancedBufferAttribute(depthArr, 1));
  pebbles.instanceMatrix.needsUpdate = true;
  if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
  pebbles.computeBoundingSphere();
  return pebbles;
}

// Painterly riverbed with animated sunlit underwater caustics and smooth
// shallow-to-deep emerald-cerulean optical absorption.
function buildBedRibbon(uniforms) {
  const SEGS = Math.round((420 / ORIGINAL_LENGTH) * STREAM_LENGTH);
  const STEPS = 12;
  const positions = [];
  const uvs = [];
  const bedDepthAttr = [];
  const index = [];

  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS;
    const p = streamCurve.getPointAt(t);
    const tan = streamCurve.getTangentAt(t);
    const bx = -tan.z, bz = tan.x;
    const bl = Math.hypot(bx, bz) || 1;
    const hw = halfWidthAt(t) + 1.4;
    const lvl = levelAt(t);
    const wy = waterSurfaceAt(t);
    for (let k = 0; k <= STEPS; k++) {
      const v = k / STEPS;
      const lat = (v * 2 - 1) * hw;
      const cross = Math.abs(v * 2 - 1);
      const by = lvl - bedDepth(cross);
      positions.push(p.x + (bx / bl) * lat, by, p.z + (bz / bl) * lat);
      uvs.push(t * 72 * LENGTH_RATIO, v * 3.2);
      bedDepthAttr.push(Math.max(0.02, wy - by));
    }
    if (i < SEGS) {
      const row = STEPS + 1;
      for (let k = 0; k < STEPS; k++) {
        const a = i * row + k;
        index.push(a, a + 1, a + row, a + row, a + 1, a + row + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aBedDepth', new THREE.Float32BufferAttribute(bedDepthAttr, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: makeBedTexture(),
    roughness: 1.0,
    metalness: 0.0,
  });
  mat.userData.skipToon = true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = `
      attribute float aBedDepth;
      varying vec3 vBedWPos;
      varying float vBedDepth;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vBedWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vBedDepth = aBedDepth;`
    );

    shader.fragmentShader = `
      uniform float uTime;
      varying vec3 vBedWPos;
      varying float vBedDepth;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_WATER_NOISE}`)
      .replace(
      '#include <opaque_fragment>',
      `{
        float shadow = wSunShadow(reflectedLight);
        float tWrap = mod(uTime, 3600.0);

        // Sunlit warm cobbles vs cool sky-lit shadowed streambed
        vec3 cobble = diffuseColor.rgb * mix(vec3(0.40, 0.56, 0.64), vec3(1.02, 0.96, 0.80), shadow);

        // Dual-scale animated Voronoi caustic lace on sunlit shallow bed
        vec2 cUv1 = vBedWPos.xz * 0.68 + vec2(tWrap * 0.52, -tWrap * 0.36);
        vec2 cUv2 = mat2(0.8, -0.6, 0.6, 0.8) * (vBedWPos.xz * 0.95 - vec2(tWrap * 0.34, tWrap * 0.44));
        vec2 cell1 = wCellular(cUv1);
        float web1 = 1.0 - smoothstep(0.035, 0.18, cell1.y - cell1.x);
        float shimmer = wNoiseGrad(cUv2).x;
        float caust = web1 * (0.55 + 0.65 * shimmer) * shadow * exp(-vBedDepth * 0.95);
        cobble += vec3(0.32, 0.54, 0.46) * caust;

        // Progressive aqua-emerald water absorption with depth
        vec3 midPool = mix(vec3(0.022, 0.16, 0.21), vec3(0.045, 0.29, 0.30), shadow);
        vec3 deepPool = mix(vec3(0.010, 0.09, 0.15), vec3(0.018, 0.17, 0.23), shadow);
        vec3 waterTint = mix(midPool, deepPool, smoothstep(0.55, 1.45, vBedDepth));
        float absorb = smoothstep(0.08, 1.35, vBedDepth);
        outgoingLight = mix(cobble, waterTint, absorb * 0.88);
      }
      #include <opaque_fragment>`
    );
  };
  mat.customProgramCacheKey = () => 'stylized-stream-bed';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// High-resolution terrain-aware stylized cartoon water surface.
function buildWaterRibbon(uniforms) {
  const SEGS = Math.round(1.9 * STREAM_LENGTH);
  const COLS = 24;
  const positions = [];
  const uvs = [];
  const depthAttr = [];
  const cascadeAttr = [];
  const plungeAttr = [];
  const narrowAttr = [];
  const widthAttr = [];
  const flowAttr = [];
  const index = [];

  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS;
    const p = streamCurve.getPointAt(t);
    const tan = streamCurve.getTangentAt(t);
    const dl = Math.hypot(tan.x, tan.z) || 1;
    // Downstream unit vector (-tangent in XZ)
    const fx = -tan.x / dl, fz = -tan.z / dl;
    const bx = -tan.z / dl, bz = tan.x / dl;

    const hw = halfWidthAt(t);
    const w = hw + 2.2; // reaches cleanly past wobbled terrain banks
    const wy = waterSurfaceAt(t);
    const casc = cascadeAt(t);
    const narrow = narrownessAt(t);
    const plunge = plungeInfoAt(t);

    for (let k = 0; k <= COLS; k++) {
      const v = k / COLS;
      const signedCross = v * 2 - 1;
      const lat = signedCross * w;
      const wx = p.x + bx * lat;
      const wz = p.z + bz * lat;

      // Exact terrain-intersection water depth so shoreline foam hugs the real
      // wobbled grassy bank instead of a straight ribbon edge.
      const th = terrainHeight(wx, wz);
      const bedCross = Math.min(1, Math.abs(lat) / (hw + 1.4));
      const by = levelAt(t) - bedDepth(bedCross);
      const floorY = Math.max(th, by);
      let realDepth = wy - floorY;
      // Guarantee cascade chutes stay solid across their core channel
      if (casc > 0.05) {
        const chuteCore = (1 - THREE.MathUtils.smoothstep(Math.abs(lat) / (hw + 0.6), 0.68, 1.02)) * 0.55 * casc;
        realDepth = Math.max(realDepth, chuteCore);
      }

      positions.push(wx, wy, wz);
      uvs.push(t * STREAM_LENGTH, v); // x = exact arc length in metres!
      depthAttr.push(realDepth);
      cascadeAttr.push(casc);
      plungeAttr.push(plunge.strength, plunge.phase);
      narrowAttr.push(narrow);
      widthAttr.push(w);
      flowAttr.push(fx, fz);
    }
    if (i < SEGS) {
      const row = COLS + 1;
      for (let k = 0; k < COLS; k++) {
        const a = i * row + k;
        index.push(a, a + 1, a + row, a + row, a + 1, a + row + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aWUv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aWDepth', new THREE.Float32BufferAttribute(depthAttr, 1));
  geo.setAttribute('aWCascade', new THREE.Float32BufferAttribute(cascadeAttr, 1));
  geo.setAttribute('aWPlunge', new THREE.Float32BufferAttribute(plungeAttr, 2));
  geo.setAttribute('aWNarrow', new THREE.Float32BufferAttribute(narrowAttr, 1));
  geo.setAttribute('aWWidth', new THREE.Float32BufferAttribute(widthAttr, 1));
  geo.setAttribute('aWFlow', new THREE.Float32BufferAttribute(flowAttr, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    roughness: 1.0,
    metalness: 0.0,
  });
  mat.userData.skipToon = true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSunDir = uniforms.uSunDir;

    shader.vertexShader = `
      attribute vec2 aWUv;
      attribute float aWDepth;
      attribute float aWCascade;
      attribute vec2 aWPlunge;
      attribute float aWNarrow;
      attribute float aWWidth;
      attribute vec2 aWFlow;

      varying vec3 vWPos;
      varying vec3 vWGeomNrm;
      varying vec2 vWUv;
      varying float vWDepth;
      varying float vWCascade;
      varying vec2 vWPlunge;
      varying float vWNarrow;
      varying float vWWidth;
      varying vec2 vWFlow;

      uniform float uTime;
    ` + shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vWGeomNrm = normalize(mat3(modelMatrix) * objectNormal);`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWUv = aWUv;
         vWDepth = aWDepth;
         vWCascade = aWCascade;
         vWPlunge = aWPlunge;
         vWNarrow = aWNarrow;
         vWWidth = aWWidth;
         vWFlow = aWFlow;
         {
           float tW = mod(uTime, 3600.0);
           // Gentle lively swell on rapids & waterfall lips
           float swell = sin(aWUv.x * 1.9 + tW * 5.2 + aWUv.y * 9.0) * 0.045 * (aWCascade + 0.25 * aWNarrow)
                       + cos(aWUv.x * 0.8 + tW * 2.4 - aWUv.y * 6.0) * 0.014 * smoothstep(0.05, 0.35, aWDepth);
           transformed.y += swell;
           vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         }`
      );

    shader.fragmentShader = `
      uniform float uTime;
      uniform vec3 uSunDir;

      varying vec3 vWPos;
      varying vec3 vWGeomNrm;
      varying vec2 vWUv;
      varying float vWDepth;
      varying float vWCascade;
      varying vec2 vWPlunge;
      varying float vWNarrow;
      varying float vWWidth;
      varying vec2 vWFlow;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_WATER_NOISE}`)
      .replace(
      '#include <opaque_fragment>',
      `{
        // Trim vertices tucked underground beneath the banks
        if (vWDepth < -0.015) discard;

        float tW = mod(uTime, 3600.0);
        float arcU = vWUv.x; // metres from downstream end (decreasing = downstream)
        float crossM = (vWUv.y * 2.0 - 1.0) * vWWidth; // metres across channel
        float depth = max(0.0, vWDepth);
        float shadow = wSunShadow(reflectedLight);

        // Flow speed increases in narrow chutes and waterfalls
        float rush = clamp(0.28 + vWNarrow * 0.45 + vWCascade * 0.85, 0.0, 1.35);

        // ---- 1. Analytic two-octave flow wave normals ----
        vec2 wCoord1 = vec2(arcU * 0.42 + tW * (1.35 + rush * 0.9), crossM * 0.55);
        vec2 wCoord2 = mat2(0.86, -0.50, 0.50, 0.86) * vec2(arcU * 0.95 + tW * (2.3 + rush * 1.2), crossM * 1.15 + 7.3);
        vec3 ng1 = wNoiseGrad(wCoord1);
        vec3 ng2 = wNoiseGrad(wCoord2);

        vec3 flowDir = normalize(vec3(vWFlow.x, 0.0, vWFlow.y));
        vec3 crossDir = vec3(-flowDir.z, 0.0, flowDir.x);
        float waveAmp = (0.11 + 0.14 * rush) * smoothstep(0.0, 0.18, depth);
        float dU = (ng1.y * 0.6 + ng2.y * 0.45) * waveAmp;
        float dV = (ng1.z * 0.6 + ng2.z * 0.45) * waveAmp;
        vec3 wNormal = normalize(vWGeomNrm + flowDir * dU + crossDir * dV);

        vec3 V = normalize(cameraPosition - vWPos);
        float NdotV = clamp(dot(wNormal, V), 0.0, 1.0);

        // ---- 2. Stylized 3-zone optical water palette (shallow -> mid -> deep) ----
        // Calibrated in linear RGB for ACESFilmicToneMapping (exposure 1.32)
        vec3 cShallow = vec3(0.095, 0.44, 0.38);  // clear spring celadon-aqua
        vec3 cMid     = vec3(0.026, 0.28, 0.29);  // vibrant forest emerald-teal
        vec3 cDeep    = vec3(0.010, 0.125, 0.195); // rich deep cerulean pool

        float dMid = smoothstep(0.04, 0.48, depth);
        float dDeep = smoothstep(0.42, 1.35, depth);
        vec3 waterCol = mix(cShallow, cMid, dMid);
        waterCol = mix(waterCol, cDeep, dDeep * (0.82 + 0.18 * ng1.x));

        // Aerated turquoise lift in plunge pools & rapids
        float aerate = clamp(vWPlunge.x * 0.75 + vWCascade * 0.45, 0.0, 1.0);
        waterCol = mix(waterCol, vec3(0.085, 0.42, 0.41), aerate * 0.58);

        // Dappled tree shadows cool the water into sapphire-teal; sunlight warms jade subsurface
        vec3 shadowTint = vec3(0.48, 0.64, 0.84);
        vec3 sunTint    = vec3(1.06, 1.12, 1.02);
        waterCol *= mix(shadowTint, sunTint, shadow);

        // ---- 3. Four-layer crisp cartoon foam ----
        // Shared cellular lace evaluated once in stretched flow coordinates
        vec2 laceUv = vec2(arcU * 0.58 + tW * (1.8 + rush * 1.4) + ng1.x * 0.65, crossM * 0.85 + (ng2.x - 0.5) * 0.55);
        vec2 cell = wCellular(laceUv);
        float cellWeb = 1.0 - smoothstep(0.04, 0.17, cell.y - cell.x);
        float cellDots = 1.0 - smoothstep(0.16, 0.30, cell.x);

        // Layer A: Organic terrain-hugging shoreline lace
        float lap = 0.032 * sin(arcU * 0.9 + tW * 2.6 + ng1.x * 3.0);
        float shoreD = depth + lap;
        // Crisp inner lip right against the wet grass/stones
        float shoreLip = (1.0 - smoothstep(0.035, 0.115, shoreD)) * smoothstep(0.004, 0.025, depth);
        // Secondary lacy cartoon foam ring just off the bank
        float shoreRingBand = smoothstep(0.09, 0.16, shoreD) * (1.0 - smoothstep(0.20, 0.34, shoreD));
        float shoreLace = shoreRingBand * smoothstep(0.42, 0.66, cellWeb * 0.75 + ng2.x * 0.45);
        float shoreFoam = clamp(shoreLip * 0.88 + shoreLace * 0.76, 0.0, 1.0);

        // Layer B: Graceful sinuous current ribbons ("water lines")
        float warpCross = crossM * 1.35 + sin(arcU * 0.28 + tW * 1.1) * 0.85 + (ng1.x - 0.5) * 1.4;
        float ribbonWave = sin(warpCross * 2.6) * 0.5 + 0.5;
        float ribbonGate = wNoiseGrad(vec2(arcU * 0.22 + tW * 1.9, crossM * 0.35 + 3.1)).x;
        float flowStrength = clamp(vWNarrow * 0.75 + vWPlunge.x * 0.55 + 0.16, 0.0, 1.0) * smoothstep(0.10, 0.30, depth);
        float ribbonFoam = smoothstep(0.84 - flowStrength * 0.14, 0.93, ribbonWave * (0.52 + 0.62 * ribbonGate)) * flowStrength * 0.62;

        // Layer C: Sculpted waterfall / cascade whitewater
        float cascStreak = wNoiseGrad(vec2(arcU * 0.85 + tW * 4.6, crossM * 1.9)).x;
        float cascSignal = cascStreak * 0.48 + cellWeb * 0.36 + cellDots * 0.34 + vWCascade * 0.26;
        float cascadeFoam = vWCascade * smoothstep(0.42, 0.58, cascSignal);
        // Solid frothy crest right on the steep waterfall lip
        cascadeFoam = max(cascadeFoam, smoothstep(0.55, 0.92, vWCascade) * smoothstep(0.28, 0.46, cascStreak + cellDots * 0.5));

        // Layer D: Animated plunge-pool splash rings & aerated bubble trails
        float pPhase = vWPlunge.y;
        float ringWave = sin(pPhase * 18.0 - tW * 4.2 + ng1.x * 2.4) * 0.5 + 0.5;
        float plungeRings = vWPlunge.x * smoothstep(0.62, 0.82, ringWave * (0.55 + 0.55 * cellWeb)) * smoothstep(0.08, 0.28, depth);

        float foamRaw = max(max(shoreFoam, cascadeFoam), max(ribbonFoam, plungeRings * 0.9));
        // Clean cartoon edge sharpening on foam silhouettes
        float foamMask = smoothstep(0.18, 0.56, foamRaw);

        // Two-tone painterly foam shading: warm creamy sunlit crests + cool sky-blue foam shadows
        float foamCrest = clamp(cellDots * 0.55 + ng2.x * 0.45 + vWCascade * 0.2, 0.0, 1.0);
        vec3 foamShadowCol = vec3(0.36, 0.54, 0.68);
        vec3 foamLitCol    = vec3(0.96, 0.95, 0.89);
        float foamLight = clamp(shadow * (0.55 + 0.45 * foamCrest) + (1.0 - shadow) * 0.18 * foamCrest, 0.0, 1.0);
        vec3 foamCol = mix(foamShadowCol, foamLitCol, foamLight);

        // ---- 4. Stylized Fresnel sky + overhanging-canopy reflection ----
        vec3 R = reflect(-V, wNormal);
        float ry = clamp(R.y, 0.0, 1.0);
        vec3 skyHorizon = vec3(0.72, 0.48, 0.24);
        vec3 skyMid     = vec3(0.30, 0.56, 0.72);
        vec3 skyZenith  = vec3(0.09, 0.30, 0.60);
        vec3 skyRefl = mix(skyHorizon, skyMid, smoothstep(0.0, 0.24, ry));
        skyRefl = mix(skyRefl, skyZenith, smoothstep(0.16, 0.62, ry));

        // Subtle lush tree-canopy reflection near banks and in dappled shade
        float bankProx = 1.0 - smoothstep(0.3, 4.2, depth * 2.6);
        float canopyHint = clamp(bankProx * 0.45 + (1.0 - shadow) * 0.42, 0.0, 0.68) * (1.0 - smoothstep(0.15, 0.55, ry));
        vec3 canopyRefl = vec3(0.055, 0.20, 0.085);
        vec3 envRefl = mix(skyRefl, canopyRefl, canopyHint);

        float fresnel = clamp(0.06 + 0.54 * pow(1.0 - NdotV, 3.2), 0.0, 0.64) * (1.0 - foamMask * 0.9);
        waterCol = mix(waterCol, envRefl, fresnel);

        // ---- 5. Toon-stepped sun specular + twinkling current sparkles ----
        vec3 H = normalize(uSunDir + V);
        float NdotH = max(dot(wNormal, H), 0.0);
        // Soft warm-aqua sun sheen
        float softSpec = pow(NdotH, 32.0) * 0.24 * shadow * (1.0 - foamMask * 0.8);
        // Crisp cartoon specular band
        float toonSpec = smoothstep(0.985, 0.993, NdotH) * 0.85 * shadow * (1.0 - foamMask * 0.7);
        // Starlight diamond glints dancing on sunlit ripples
        float spA = wHash21(floor(vec2(arcU * 3.1 + tW * 3.8, crossM * 3.4)));
        float spWave = sin(tW * 5.5 + spA * 31.4) * 0.5 + 0.5;
        float sparkle = smoothstep(0.93, 0.985, ng2.x * 0.65 + spWave * 0.42)
                      * smoothstep(0.72, 0.95, NdotH + 0.22)
                      * shadow * (1.0 - foamMask) * (0.45 + 0.65 * rush);

        waterCol += vec3(0.98, 0.92, 0.74) * (softSpec + toonSpec + sparkle * 1.15);

        // Composite two-tone cartoon foam over water
        vec3 finalCol = mix(waterCol, foamCol, foamMask);

        // ---- 6. Optical transmittance (clear shallows -> rich jewel pools) ----
        float edgeFeather = smoothstep(-0.005, 0.045, vWDepth);
        float baseAlpha = mix(0.18, 0.88, smoothstep(0.04, 1.18, depth));
        baseAlpha = max(baseAlpha, vWCascade * 0.76);
        float finalAlpha = clamp(baseAlpha + fresnel * 0.34 + foamMask * 0.92 + toonSpec * 0.4, 0.0, 1.0) * edgeFeather;

        gl_FragColor = vec4(finalCol, finalAlpha);
      }`
    );
  };
  mat.customProgramCacheKey = () => 'stylized-cozy-water';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  return { mesh, uniforms };
}

// Animated cartoon boulder wakes flush on the water surface (+x = downstream):
// upstream bubbly horseshoe collar + trailing V-shaped cartoon foam arms.
function buildWakeMesh(foamRings, uniforms) {
  const wakeGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
  wakeGeo.rotateX(-Math.PI / 2);

  const phaseArr = new Float32Array(foamRings.length);
  const wakeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  wakeMat.userData.skipToon = true;

  wakeMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = `
      attribute float aWakePhase;
      varying vec2 vWakeUv;
      varying float vWakePhase;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vWakeUv = uv;
       vWakePhase = aWakePhase;`
    );

    shader.fragmentShader = `
      uniform float uTime;
      varying vec2 vWakeUv;
      varying float vWakePhase;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_WATER_NOISE}`)
      .replace(
      '#include <opaque_fragment>',
      `{
        // Local coordinates: x in [-0.32, +0.68] (+x downstream), y in [-1, +1]
        float x = vWakeUv.x - 0.30;
        float y = (vWakeUv.y - 0.5) * 2.0;
        float tW = mod(uTime, 3600.0) + vWakePhase;

        // Rock footprint sits near (0, 0) with radius ~0.27 in card space
        float r = length(vec2(x * 1.18, y * 0.88));
        float pulse = 0.022 * sin(tW * 3.8 + y * 5.0);

        // 1. Upstream horseshoe bow-wave collar wrapping the boulder
        float collarBand = smoothstep(0.18, 0.25, r + pulse) * (1.0 - smoothstep(0.28, 0.40, r + pulse));
        float upstreamBias = smoothstep(0.32, -0.12, x);
        vec2 nBow = wCellular(vec2(x * 7.5 - tW * 2.2, y * 5.5));
        float bowBubbles = 1.0 - smoothstep(0.14, 0.32, nBow.x);
        float collar = collarBand * upstreamBias * (0.65 + 0.55 * bowBubbles);

        // 2. Two trailing V-wake arms + centre bubble stream flowing downstream (+x)
        float downMask = smoothstep(-0.08, 0.12, x) * (1.0 - smoothstep(0.35, 0.70, x));
        float armY = 0.24 + x * 0.62;
        float armDist = abs(abs(y) - armY);
        float armBand = (1.0 - smoothstep(0.04, 0.19 + x * 0.14, armDist)) * downMask;

        float streamNoise = wNoiseGrad(vec2(x * 8.5 - tW * 3.6, y * 6.0)).x;
        float droplets = 1.0 - smoothstep(0.16, 0.33, wCellular(vec2(x * 9.0 - tW * 3.9, y * 6.5)).x);
        float arms = armBand * smoothstep(0.36, 0.64, streamNoise * 0.6 + droplets * 0.6);

        // Subtle centre wake froth just behind the rock
        float tailMask = smoothstep(0.05, 0.20, x) * (1.0 - smoothstep(0.26, 0.56, x))
                       * (1.0 - smoothstep(0.0, 0.26, abs(y)));
        float tail = tailMask * smoothstep(0.46, 0.70, droplets * 0.7 + streamNoise * 0.45);

        // Fade cleanly before quad border so a rectangular edge can never show
        float borderFade = smoothstep(0.0, 0.09, vWakeUv.x) * (1.0 - smoothstep(0.88, 1.0, vWakeUv.x))
                         * (1.0 - smoothstep(0.80, 0.98, abs(y)));

        float foam = smoothstep(0.22, 0.58, max(collar, max(arms, tail))) * borderFade;
        if (foam < 0.01) discard;

        float shadow = wSunShadow(reflectedLight);
        vec3 shadowCol = vec3(0.38, 0.56, 0.70);
        vec3 litCol    = vec3(0.97, 0.96, 0.90);
        vec3 col = mix(shadowCol, litCol, clamp(shadow * (0.65 + 0.35 * droplets) + 0.12 * droplets, 0.0, 1.0));

        gl_FragColor = vec4(col, foam * 0.90);
      }`
    );
  };
  wakeMat.customProgramCacheKey = () => 'stylized-rock-wake';

  const wakes = new THREE.InstancedMesh(wakeGeo, wakeMat, foamRings.length);
  wakes.receiveShadow = true;
  wakes.renderOrder = 3;

  const dummy = new THREE.Object3D();
  foamRings.forEach((r, i) => {
    // Anchor around rock centre with downstream extension along local +x
    dummy.position.set(r.x + r.dx * r.r * 0.55, r.y, r.z + r.dz * r.r * 0.55);
    dummy.rotation.set(0, Math.atan2(-r.dz, r.dx), 0);
    dummy.scale.set(r.r * 2.5, 1, r.r * 1.65);
    dummy.updateMatrix();
    wakes.setMatrixAt(i, dummy.matrix);
    phaseArr[i] = r.phase;
  });

  wakeGeo.setAttribute('aWakePhase', new THREE.InstancedBufferAttribute(phaseArr, 1));
  wakes.instanceMatrix.needsUpdate = true;
  wakes.computeBoundingSphere();
  return wakes;
}
