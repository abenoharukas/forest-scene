import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  streamCurve, levelAt, cascadeAt, halfWidthAt, narrownessAt, DROPS, DROP_LEN,
  STREAM_LENGTH, tOfArc, tSpan, originalT,
} from './streamPath.js';
import { terrainHeight } from './terrain.js';
import { makeRockTexture, makeBedTexture } from './textures.js';
import { withSeed } from './rng.js';

// Clear woodland brook inspired directly by Cozy Country (Protopop):
//   - Crystal-clear spring water (zero swimming-pool blue!) revealing a dense,
//     wave-refracted river-gravel bed all the way across the channel.
//   - Warm olive-sage & mossy forest-canopy reflections with silky, feathery
//     longitudinal current threads and soft frothy whitewater rapids.
//   - Soft drifting mist / spray puffs rising over cascades and rocky riffles.
//   - Sculpted, warm sunlit sandstone/limestone boulders firmly embedded in
//     the banks and streambed (de-overlapped so rocks never stack or float).

const WATER_Y_OFFSET = -0.06;
const waterSurfaceAt = (t) => levelAt(t) + WATER_Y_OFFSET;

const ORIGINAL_LENGTH = 326.409;
const LENGTH_RATIO = STREAM_LENGTH / ORIGINAL_LENGTH;
const perLength = (authored) => Math.round(authored * LENGTH_RATIO);

const SUN_DIR = new THREE.Vector3(60, 92, -120).normalize();

// Shallow mountain brook profile (0.18m at banks -> 0.72m in deepest middle)
function bedDepth(cross) {
  return 0.18 + 0.54 * (1 - cross * cross);
}

function plungeInfoAt(t) {
  const u = t * STREAM_LENGTH;
  let bestS = 0;
  let bestP = 0;
  for (const d of DROPS) {
    const distBelow = (d.u - 0.30 * DROP_LEN) - u;
    const span = DROP_LEN * 3.8;
    if (distBelow >= 0 && distBelow <= span) {
      const p = distBelow / span;
      const s = (1 - p) * (1 - p * 0.4);
      if (s > bestS) {
        bestS = s;
        bestP = p;
      }
    }
  }
  return { strength: bestS, phase: bestP };
}

const GLSL_BROOK_COMMON = /* glsl */ `
  float wHash21(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794) + vec2(0.1, 0.17));
    p *= 17.0;
    return fract(p.x * p.y * (p.x + p.y));
  }

  // Smooth quintic value noise + analytical gradient: vec3(val, ddx, ddy)
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

  // Three-octave silky anisotropic flow FBM for feathery Cozy Country water streaks
  float wFlowFbm(vec2 p, float tShift) {
    float v = 0.0;
    v += 0.52 * wNoiseGrad(p + vec2(tShift, 0.0)).x;
    v += 0.31 * wNoiseGrad(p * vec2(2.05, 2.35) + vec2(tShift * 1.65, 3.7)).x;
    v += 0.17 * wNoiseGrad(p * vec2(4.10, 4.70) + vec2(tShift * 2.40, -5.1)).x;
    return v;
  }

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
    const rockMat = makePainterlyBoulderMaterial(rockTex);
    const variants = [buildSculptedRockGeo(0), buildSculptedRockGeo(1), buildSculptedRockGeo(2)];
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();

    const rockBuckets = variants.map(() => []);
    const placedRocks = []; // spatial de-overlap so boulders never stack on each other
    const foamRings = [];

    const canPlaceRock = (x, z, r, minFactor = 0.78) => {
      for (let i = 0; i < placedRocks.length; i++) {
        const pr = placedRocks[i];
        const dx = x - pr.x, dz = z - pr.z;
        const minD = (r + pr.r) * minFactor;
        if (dx * dx + dz * dz < minD * minD) return false;
      }
      return true;
    };

    // Lowest ground around a boulder's footprint so steep banks never leave an edge hanging in air
    const minGroundAround = (x, z, r) => {
      const d = r * 0.65;
      return Math.min(
        terrainHeight(x, z),
        terrainHeight(x - d, z),
        terrainHeight(x + d, z),
        terrainHeight(x, z - d),
        terrainHeight(x, z + d)
      );
    };

    const addRing = (x, z, t, radius) => {
      const tc = THREE.MathUtils.clamp(t, 0, 1);
      const tan = streamCurve.getTangentAt(tc);
      const dl = Math.hypot(tan.x, tan.z) || 1;
      foamRings.push({
        x,
        z,
        y: waterSurfaceAt(tc) + 0.012,
        r: radius,
        dx: -tan.x / dl,
        dz: -tan.z / dl,
        phase: Math.random() * 10.0,
      });
    };

    const addBoulder = (vIdx, cx, cz, y, s, waterY, { flat = false, checkOverlap = true, overlapK = 0.78 } = {}) => {
      const horizR = s * 1.05;
      if (checkOverlap && !canPlaceRock(cx, cz, horizR, overlapK)) return 0;
      placedRocks.push({ x: cx, z: cz, r: horizR });

      const sx = s * (0.90 + Math.random() * 0.36);
      const sy = s * (flat ? 0.36 + Math.random() * 0.22 : 0.54 + Math.random() * 0.30);
      const sz = s * (0.90 + Math.random() * 0.36);
      const rx = (Math.random() - 0.5) * 0.22;
      const ry = Math.random() * Math.PI * 2;
      const rz = (Math.random() - 0.5) * 0.22;

      dummy.position.set(cx, y, cz);
      dummy.rotation.set(rx, ry, rz);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      // Warm cream/buff sandstone to light grey-ochre (in sRGB so stones stay bright like Cozy Country)
      col.setHSL(
        0.10 + (Math.random() - 0.5) * 0.03,
        0.12 + Math.random() * 0.10,
        0.78 + Math.random() * 0.16,
        THREE.SRGBColorSpace
      );

      rockBuckets[vIdx].push({
        matrix: dummy.matrix.clone(),
        color: col.clone(),
        waterY,
      });
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

    const findShoreline = (t, side) => {
      const tc = THREE.MathUtils.clamp(t, 0, 1);
      const p = streamCurve.getPointAt(tc);
      const tan = streamCurve.getTangentAt(tc);
      const bx = -tan.z, bz = tan.x;
      const bl = Math.hypot(bx, bz) || 1;
      const wy = waterSurfaceAt(tc);
      const hw = halfWidthAt(tc);
      for (let off = Math.max(1.0, hw - 1.6); off < hw + 4.8; off += 0.25) {
        const x = p.x + (bx / bl) * off * side;
        const z = p.z + (bz / bl) * off * side;
        if (terrainHeight(x, z) >= wy - 0.02) {
          return { x, z, off, wy };
        }
      }
      return null;
    };

    // ---- 1. Hand-placed hero boulders in the opening brook view ----
    {
      const hero = [
        { t: originalT(0.395), lat: 3.6, s: 1.45 },  // foreground right bank boulder (like sample.mp4!)
        { t: originalT(0.415), lat: -1.4, s: 1.05 }, // mid-brook stepping boulder
        { t: originalT(0.432), lat: 2.3, s: 1.30 },  // right-edge boulder catching current
        { t: originalT(0.448), lat: -2.8, s: 1.35 }, // left-bank mossy boulder
        { t: originalT(0.468), lat: 0.7, s: 0.85 },  // upstream mid-brook stone
      ];
      hero.forEach((hr, i) => {
        const { x, z } = lateral(hr.t, hr.lat);
        const wy = waterSurfaceAt(hr.t);
        const minGround = minGroundAround(x, z, hr.s);
        const y = Math.max(minGround, wy - 0.42) + hr.s * 0.14;
        const sy = addBoulder(i % 3, x, z, y, hr.s, wy, { checkOverlap: false });
        if (Math.abs(hr.lat) < halfWidthAt(hr.t) + 0.5 && sy > 0) {
          addRing(x, z, hr.t, hr.s * 1.4);
        }
      });
    }

    // ---- 2. Stone sills across every cascade lip ----
    {
      const perDrop = 6;
      const SILL_JITTER = tSpan(1.1);
      for (const d of DROPS) {
        const tLip = tOfArc(d.u + DROP_LEN * 0.35);
        const hw = halfWidthAt(tLip);
        const tFoot = tOfArc(d.u + DROP_LEN * 0.82);
        const wy = waterSurfaceAt(tLip);
        for (let k = 0; k < perDrop; k++) {
          const lat = ((k + 0.5) / perDrop - 0.5) * 2 * (hw * 0.92) + (Math.random() - 0.5) * 0.8;
          const tt = THREE.MathUtils.clamp(tLip + (Math.random() - 0.5) * SILL_JITTER, 0, 1);
          const { x, z } = lateral(tt, lat);
          const s = 0.65 + Math.random() * 0.85;
          const vIdx = (k + ((Math.random() * 3) | 0)) % 3;
          const sy = addBoulder(vIdx, x, z, wy - 0.30 + s * 0.22, s, wy, { overlapK: 0.62 });
          if (sy > 0) addRing(x, z, tFoot, s * 1.3);
        }
      }
    }

    // ---- 3. Natural shoreline boulder & cobble clusters hugging both banks ----
    {
      const CLUSTERS = perLength(95);
      for (let c = 0; c < CLUSTERS; c++) {
        const tt = Math.random();
        const side = Math.random() < 0.5 ? 1 : -1;
        const shore = findShoreline(tt, side);
        if (!shore) continue;
        const count = 2 + ((Math.random() * 3) | 0);
        for (let k = 0; k < count; k++) {
          const tk = THREE.MathUtils.clamp(tt + tSpan((Math.random() - 0.5) * 3.8), 0, 1);
          const sh = k === 0 ? shore : findShoreline(tk, side);
          if (!sh) continue;
          const inOut = (Math.random() - 0.45) * 1.25;
          const { x, z } = lateral(tk, (sh.off + inOut) * side);
          const s = k === 0 ? 0.65 + Math.random() * 0.85 : 0.32 + Math.random() * 0.52;
          const wy = waterSurfaceAt(tk);
          // Firmly sink into the lowest edge of sloped banks so stones NEVER float!
          const minG = minGroundAround(x, z, s);
          const y = Math.max(minG + s * 0.12, wy - 0.45 + s * 0.20);
          const sy = addBoulder((c + k) % 3, x, z, y, s, wy, { flat: Math.random() < 0.6, overlapK: 0.82 });
          if (sy > 0 && inOut < -0.1 && y + sy > wy + 0.04 && y - sy < wy) {
            addRing(x, z, tk, s * 1.25);
          }
        }
      }
    }

    // ---- 4. Emergent mid-brook stepping stones + grassy bank boulders ----
    {
      const streamStones = perLength(68);
      for (let i = 0; i < streamStones; i++) {
        const tt = Math.random();
        const hw = halfWidthAt(tt);
        const lat = (Math.random() - 0.5) * 2 * Math.max(0.8, hw - 0.6);
        const { x, z } = lateral(tt, lat);
        const s = 0.30 + Math.random() * 0.68;
        const wy = waterSurfaceAt(tt);
        const cross = Math.min(1, Math.abs(lat) / (hw + 1.0));
        const bedY = levelAt(tt) - bedDepth(cross);
        const y = bedY + s * 0.34;
        const sy = addBoulder(i % 3, x, z, y, s, wy, { flat: true, overlapK: 0.85 });
        if (sy > 0 && y + sy * 0.85 > wy + 0.03 && y - sy < wy) {
          addRing(x, z, tt, s * 1.35);
        }
      }

      const bankStones = perLength(26);
      for (let i = 0; i < bankStones; i++) {
        const tt = Math.random();
        const hw = halfWidthAt(tt);
        const side = Math.random() < 0.5 ? 1 : -1;
        const lat = (hw + 1.2 + Math.random() * 3.5) * side;
        const { x, z } = lateral(tt, lat);
        const s = 0.75 + Math.random() * 1.25;
        const wy = waterSurfaceAt(tt);
        const minG = minGroundAround(x, z, s);
        addBoulder(i % 3, x, z, minG + s * 0.16, s, wy, { overlapK: 0.85 });
      }
    }

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

    // ---- 5. Submerged brook cobbles visible through the crystal-clear water ----
    group.add(buildSubmergedPebbles(buildSculptedRockGeo(3, 2), rockTex, uniforms, lateral));

    // ---- 6. Soft feathery boulder wakes flush on the water surface ----
    if (foamRings.length) {
      group.add(buildWakeMesh(foamRings, uniforms));
    }

    // ---- 7. Soft drifting mist / water-vapor puffs over cascades & rapids ----
    group.add(buildStreamMist(uniforms, lateral));

    return {
      group,
      update(dt) {
        uniforms.uTime.value += dt;
      },
    };
  });
}

// Sculpted river-boulder geometry: planar rock facets + ridged bevels on
// merged vertices so boulders look like natural chunky river stones instead of
// smooth round potatoes or golf balls.
function buildSculptedRockGeo(seedIdx, detail = 3) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute('uv');
  const g = mergeVertices(raw);
  const pos = g.attributes.position;
  const uvs = new Float32Array(pos.count * 2);

  // Random planar cuts give each boulder variant natural sandstone facets
  const planes = [];
  for (let k = 0; k < 5; k++) {
    const dir = new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.3) * 0.9, Math.random() - 0.5).normalize();
    planes.push({ dir, cut: 0.74 + Math.random() * 0.20 });
  }
  const f1 = 1.6 + seedIdx * 0.45 + Math.random() * 0.4;
  const f2 = 2.9 + seedIdx * 0.6 + Math.random() * 0.6;
  const ph = Math.random() * 6.28;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Ridged rock noise for crisp stone planes with soft bevels
    const ridge1 = 1.0 - Math.abs(Math.sin(v.x * f1 + v.z * 1.3 + ph));
    const ridge2 = 1.0 - Math.abs(Math.cos(v.y * f2 - v.x * 1.5 + ph * 0.7));
    let r = 0.88 + ridge1 * 0.16 + ridge2 * 0.08;
    v.multiplyScalar(r);

    // Soft planar chamfers (like Cozy Country's chunky painterly rocks)
    for (const pl of planes) {
      const proj = v.dot(pl.dir);
      if (proj > pl.cut) {
        v.addScaledVector(pl.dir, -(proj - pl.cut) * 0.68);
      }
    }
    // Flatter base so rocks sit naturally on ground/bed
    if (v.y < 0) v.y *= 0.68;
    else v.y *= 0.88;

    pos.setXYZ(i, v.x, v.y, v.z);
    uvs[i * 2] = Math.atan2(v.z, v.x) / (Math.PI * 2) + 0.5;
    uvs[i * 2 + 1] = v.y * 0.5 + 0.5;
  }
  pos.needsUpdate = true;
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

// Dedicated painterly boulder shader: warm golden-cream sunlit faces & neutral
// olive-slate shadows (never violet-purple!), broken natural moss patches,
// subtle wet waterline rim, and warm olive underwater tint.
function makePainterlyBoulderMaterial(rockTex) {
  const mat = new THREE.MeshStandardMaterial({
    map: rockTex,
    roughness: 0.95,
    metalness: 0.0,
  });
  mat.userData.skipToon = true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = { value: SUN_DIR.clone() };
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
      uniform vec3 uSunDir;
      varying vec3 vRockWPos;
      varying vec3 vRockWNrm;
      varying float vRockWaterY;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_BROOK_COMMON}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float shadow = wSunShadow(reflectedLight);
          vec3 N = normalize(vRockWNrm);
          float dy = vRockWPos.y - vRockWaterY;

          vec3 albedo = diffuseColor.rgb;

          // Broken, dappled yellow-green moss patches only on select stone pockets
          float m1 = wNoiseGrad(vRockWPos.xz * 0.95 + vec2(3.1, 7.4)).x;
          float m2 = wNoiseGrad(vRockWPos.xz * 2.7 - vec2(5.2, 1.8)).x;
          float mossSignal = m1 * 0.65 + m2 * 0.35 + N.y * 0.35;
          float mossMask = smoothstep(0.92, 1.12, mossSignal) * smoothstep(0.08, 0.28, dy);
          vec3 mossCol = vec3(0.24, 0.36, 0.085);
          albedo = mix(albedo, mossCol, mossMask * 0.78);

          // Gentle wet river-stone darkening right along the waterline
          float wetRim = 1.0 - smoothstep(-0.02, 0.16, dy);
          albedo *= mix(1.0, 0.70, wetRim);

          // Warm sunlit cream-sandstone vs neutral mossy-slate shadow (like Cozy Country)
          float sunFace = smoothstep(0.05, 0.38, dot(N, uSunDir)) * shadow;
          float skyUp = N.y * 0.5 + 0.5;
          vec3 shadowLight = mix(vec3(0.28, 0.31, 0.27), vec3(0.46, 0.50, 0.45), skyUp);
          vec3 sunLight    = vec3(1.08, 0.98, 0.78);
          vec3 rockCol = albedo * mix(shadowLight, sunLight, sunFace);

          // Soft warm rim on sunlit top edges
          vec3 V = normalize(cameraPosition - vRockWPos);
          float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.8) * sunFace * 0.22;
          rockCol += albedo * vec3(1.0, 0.92, 0.72) * rim;

          // Subtle clear-water olive softening below the waterline
          float subDepth = max(0.0, -dy);
          if (subDepth > 0.0) {
            float absorb = clamp(subDepth * 0.75, 0.0, 0.42);
            rockCol = mix(rockCol * 0.86, vec3(0.11, 0.16, 0.09), absorb);
          }

          outgoingLight = rockCol;
        }
        #include <opaque_fragment>`
      );
  };
  mat.customProgramCacheKey = () => 'painterly-brook-boulder';
  return mat;
}

// Submerged river cobbles scattered across the gravel bed: clear warm-olive &
// buff tones with soft sunlit water-ripple shimmer (zero blue tint!).
function buildSubmergedPebbles(baseGeo, rockTex, uniforms, lateral) {
  const COUNT = perLength(520);
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
      .replace('#include <common>', `#include <common>\n${GLSL_BROOK_COMMON}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float shadow = wSunShadow(reflectedLight);
          float tW = mod(uTime, 3600.0);
          float upFace = clamp(vPebWNrm.y * 0.5 + 0.5, 0.0, 1.0);

          vec3 litStone = diffuseColor.rgb * mix(vec3(0.36, 0.40, 0.34), vec3(0.88, 0.84, 0.68), shadow * upFace);

          // Soft organic sunlit water-ripple shimmer (no honeycomb grid)
          float r1 = wNoiseGrad(vPebWPos.xz * 1.35 + vec2(tW * 0.85, -tW * 0.55)).x;
          float r2 = wNoiseGrad(vPebWPos.xz * 2.20 - vec2(tW * 0.60, tW * 0.75)).x;
          float shimmer = smoothstep(0.56, 0.84, r1 * 0.55 + r2 * 0.55) * shadow * max(vPebWNrm.y, 0.0);
          litStone += vec3(0.18, 0.19, 0.12) * shimmer * exp(-vSubDepth * 0.9);

          // Mild mossy-olive water depth softening (stays crisp and readable!)
          vec3 brookTint = mix(vec3(0.06, 0.09, 0.055), vec3(0.12, 0.16, 0.095), shadow);
          float absorb = clamp(vSubDepth * 0.42, 0.0, 0.34);
          outgoingLight = mix(litStone, brookTint, absorb);
        }
        #include <opaque_fragment>`
      );
  };
  mat.customProgramCacheKey = () => 'submerged-brook-pebbles';

  const pebbles = new THREE.InstancedMesh(geo, mat, COUNT);
  pebbles.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  for (let i = 0; i < COUNT; i++) {
    const tt = Math.random();
    const hw = halfWidthAt(tt);
    const lat = (Math.random() * 2 - 1) * (hw - 0.25);
    const { x, z } = lateral(tt, lat);
    const s = 0.12 + Math.random() * 0.34;
    const cross = Math.min(1, Math.abs(lat) / (hw + 1.0));
    const y = levelAt(tt) - bedDepth(cross) + s * 0.22;
    const wy = waterSurfaceAt(tt);

    dummy.position.set(x, y, z);
    dummy.rotation.set((Math.random() - 0.5) * 0.35, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.35);
    dummy.scale.set(s * (0.9 + Math.random() * 0.35), s * (0.38 + Math.random() * 0.24), s * (0.9 + Math.random() * 0.35));
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);

    const tone = Math.random();
    if (tone < 0.45) col.setHSL(0.11, 0.18, 0.62 + Math.random() * 0.16, THREE.SRGBColorSpace); // warm buff/sand
    else if (tone < 0.78) col.setHSL(0.16, 0.08, 0.54 + Math.random() * 0.16, THREE.SRGBColorSpace); // neutral warm grey
    else col.setHSL(0.23, 0.20, 0.46 + Math.random() * 0.14, THREE.SRGBColorSpace); // mossy olive stone
    pebbles.setColorAt(i, col);

    depthArr[i] = Math.max(0.04, wy - y);
  }

  geo.setAttribute('aSubDepth', new THREE.InstancedBufferAttribute(depthArr, 1));
  pebbles.instanceMatrix.needsUpdate = true;
  if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
  pebbles.computeBoundingSphere();
  return pebbles;
}

// Dense river-gravel bed with flowing wave-refraction UV distortion so the
// pebbles visibly shimmer beneath the clear water like Cozy Country.
function buildBedRibbon(uniforms) {
  const SEGS = Math.round(1.5 * STREAM_LENGTH);
  const STEPS = 12;
  const positions = [];
  const uvs = [];
  const bedDepthAttr = [];
  const flowAttr = [];
  const index = [];

  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS;
    const p = streamCurve.getPointAt(t);
    const tan = streamCurve.getTangentAt(t);
    const dl = Math.hypot(tan.x, tan.z) || 1;
    const fx = -tan.x / dl, fz = -tan.z / dl;
    const bx = -tan.z / dl, bz = tan.x / dl;
    const hw = halfWidthAt(t) + 1.3;
    const lvl = levelAt(t);
    const wy = waterSurfaceAt(t);
    for (let k = 0; k <= STEPS; k++) {
      const v = k / STEPS;
      const lat = (v * 2 - 1) * hw;
      const cross = Math.abs(v * 2 - 1);
      const by = lvl - bedDepth(cross);
      positions.push(p.x + bx * lat, by, p.z + bz * lat);
      // World-metre UV scale so gravel grain size stays crisp & uniform at every width
      uvs.push(t * STREAM_LENGTH * 0.34, lat * 0.34);
      bedDepthAttr.push(Math.max(0.02, wy - by));
      flowAttr.push(fx, fz);
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
  geo.setAttribute('aBedFlow', new THREE.Float32BufferAttribute(flowAttr, 2));
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
      attribute vec2 aBedFlow;
      varying vec3 vBedWPos;
      varying float vBedDepth;
      varying vec2 vBedFlow;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vBedWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vBedDepth = aBedDepth;
       vBedFlow = aBedFlow;`
    );

    shader.fragmentShader = `
      uniform float uTime;
      varying vec3 vBedWPos;
      varying float vBedDepth;
      varying vec2 vBedFlow;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_BROOK_COMMON}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float shadow = wSunShadow(reflectedLight);
          float tW = mod(uTime, 3600.0);

          // Flowing ripple refraction distorts the gravel bed subtly as water streams over it
          vec2 flowUv = vec2(vMapUv.x * 2.4 + tW * 2.1, vMapUv.y * 2.8);
          vec3 refWave = wNoiseGrad(flowUv);
          vec2 refractedUv = vMapUv + refWave.yz * (0.024 * clamp(vBedDepth * 1.8, 0.2, 1.0));
          vec3 gravelTex = texture2D(map, refractedUv).rgb;

          // Warm sunlit river gravel vs cool mossy-olive shade
          vec3 gravel = gravelTex * mix(vec3(0.42, 0.47, 0.39), vec3(0.96, 0.92, 0.76), shadow);

          // Soft organic sunlit ripple caustics (no Voronoi grid lines!)
          float c1 = wNoiseGrad(vec2(vMapUv.x * 3.8 + tW * 1.6, vMapUv.y * 4.2 - tW * 0.5)).x;
          float c2 = wNoiseGrad(mat2(0.8, -0.6, 0.6, 0.8) * vec2(vMapUv.x * 4.5 - tW * 1.1, vMapUv.y * 4.8 + tW * 0.7)).x;
          float sunShimmer = smoothstep(0.58, 0.86, c1 * 0.52 + c2 * 0.52) * shadow;
          gravel += vec3(0.18, 0.20, 0.13) * sunShimmer * exp(-vBedDepth * 0.85);

          // Gentle mossy-sage depth softening so deep middle feels watery yet stays transparent
          vec3 poolFloor = mix(vec3(0.065, 0.095, 0.058), vec3(0.13, 0.17, 0.105), shadow);
          float absorb = smoothstep(0.12, 0.95, vBedDepth) * 0.32;
          outgoingLight = mix(gravel, poolFloor, absorb);
        }
        #include <opaque_fragment>`
      );
  };
  mat.customProgramCacheKey = () => 'cozy-gravel-bed';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// Clear, silky, foamy woodland-brook surface (zero blue swimming-pool tint!).
function buildWaterRibbon(uniforms) {
  const SEGS = Math.round(2.0 * STREAM_LENGTH);
  const COLS = 22;
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
    const fx = -tan.x / dl, fz = -tan.z / dl;
    const bx = -tan.z / dl, bz = tan.x / dl;

    const hw = halfWidthAt(t);
    const w = hw + 2.1;
    const wy = waterSurfaceAt(t);
    const casc = cascadeAt(t);
    const narrow = narrownessAt(t);
    const plunge = plungeInfoAt(t);

    for (let k = 0; k <= COLS; k++) {
      const v = k / COLS;
      const lat = (v * 2 - 1) * w;
      const wx = p.x + bx * lat;
      const wz = p.z + bz * lat;

      const th = terrainHeight(wx, wz);
      const bedCross = Math.min(1, Math.abs(lat) / (hw + 1.3));
      const by = levelAt(t) - bedDepth(bedCross);
      const floorY = Math.max(th, by);
      let realDepth = wy - floorY;
      if (casc > 0.05) {
        const chuteCore = (1 - THREE.MathUtils.smoothstep(Math.abs(lat) / (hw + 0.5), 0.68, 1.02)) * 0.42 * casc;
        realDepth = Math.max(realDepth, chuteCore);
      }

      positions.push(wx, wy, wz);
      uvs.push(t * STREAM_LENGTH, v);
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
           float swell = sin(aWUv.x * 2.1 + tW * 5.4 + aWUv.y * 8.0) * 0.038 * (aWCascade + 0.25 * aWNarrow)
                       + cos(aWUv.x * 0.9 + tW * 2.5 - aWUv.y * 5.0) * 0.012 * smoothstep(0.04, 0.25, aWDepth);
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
      .replace('#include <common>', `#include <common>\n${GLSL_BROOK_COMMON}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          if (vWDepth < -0.01) discard;

          float tW = mod(uTime, 3600.0);
          float arcU = vWUv.x; // metres along stream (decreasing = downstream)
          float crossM = (vWUv.y * 2.0 - 1.0) * vWWidth;
          float depth = max(0.0, vWDepth);
          float shadow = wSunShadow(reflectedLight);

          float rush = clamp(0.32 + vWNarrow * 0.55 + vWCascade * 0.95 + vWPlunge.x * 0.45, 0.0, 1.5);

          // ---- 1. Smooth flowing wave normals (stretched along current) ----
          vec2 wCoord1 = vec2(arcU * 0.48 + tW * (1.8 + rush * 0.9), crossM * 1.05);
          vec2 wCoord2 = mat2(0.92, -0.39, 0.39, 0.92) * vec2(arcU * 1.10 + tW * (2.9 + rush * 1.2), crossM * 2.1 + 5.7);
          vec3 ng1 = wNoiseGrad(wCoord1);
          vec3 ng2 = wNoiseGrad(wCoord2);

          vec3 flowDir = normalize(vec3(vWFlow.x, 0.0, vWFlow.y));
          vec3 crossDir = vec3(-flowDir.z, 0.0, flowDir.x);
          float waveAmp = (0.09 + 0.11 * rush) * smoothstep(0.0, 0.14, depth);
          vec3 wNormal = normalize(vWGeomNrm + flowDir * (ng1.y * 0.55 + ng2.y * 0.45) * waveAmp
                                             + crossDir * (ng1.z * 0.55 + ng2.z * 0.45) * waveAmp);

          vec3 V = normalize(cameraPosition - vWPos);
          float NdotV = clamp(dot(wNormal, V), 0.0, 1.0);

          // ---- 2. Natural woodland spring-water tint (olive-sage / mossy celadon, ZERO blue!) ----
          vec3 cShallow = vec3(0.18, 0.23, 0.14); // clear warm spring glass
          vec3 cDeep    = vec3(0.08, 0.15, 0.08); // soft mossy woodland pool (G > R >= B)
          vec3 waterCol = mix(cShallow, cDeep, smoothstep(0.06, 0.68, depth));

          // Dappled forest shadow vs warm golden sunlight
          waterCol *= mix(vec3(0.58, 0.66, 0.56), vec3(1.06, 1.05, 0.92), shadow);

          // ---- 3. Forest-canopy green + warm filtered sky Fresnel reflection ----
          vec3 R = reflect(-V, wNormal);
          float ry = clamp(R.y, 0.0, 1.0);
          vec3 canopyRefl = mix(vec3(0.075, 0.135, 0.052), vec3(0.19, 0.27, 0.11), shadow);
          vec3 skySheen   = mix(vec3(0.32, 0.36, 0.30), vec3(0.56, 0.57, 0.46), smoothstep(0.0, 0.35, ry));
          float treeCover = clamp((1.0 - smoothstep(0.12, 0.52, ry)) * 0.72 + (1.0 - shadow) * 0.35, 0.0, 0.88);
          vec3 envRefl = mix(skySheen, canopyRefl, treeCover);

          float fresnel = clamp(0.04 + 0.34 * pow(1.0 - NdotV, 3.0), 0.0, 0.38);
          waterCol = mix(waterCol, envRefl, fresnel);

          // ---- 4. Silky, feathery Cozy Country flow streaks & soft frothy rapids ----
          // Highly anisotropic coordinates (stretched ~9x along arcU vs crossM)
          float warpY = crossM + (ng1.x - 0.5) * 0.75 + sin(arcU * 0.22 + tW * 0.8) * 0.35;
          float streak1 = wFlowFbm(vec2(arcU * 0.26, warpY * 2.15), tW * (1.75 + rush * 0.85));
          float streak2 = wFlowFbm(vec2(arcU * 0.52 + 11.3, warpY * 3.6 - 4.2), tW * (2.65 + rush * 1.15));

          // Delicate silky threads everywhere so the whole brook visibly flows
          float silkyThreads = smoothstep(0.52, 0.84, streak1 * 0.58 + streak2 * 0.42)
                             * (0.14 + 0.32 * vWNarrow + 0.25 * vWPlunge.x)
                             * smoothstep(0.03, 0.18, depth);

          // Soft feathery riffle & waterfall whitewater (no hard comic-cutout edges!)
          float rapidMix = streak1 * 0.46 + streak2 * 0.54;
          float cascadeFroth = vWCascade * smoothstep(0.24, 0.74, rapidMix + vWCascade * 0.30);
          float plungeFroth  = vWPlunge.x * smoothstep(0.40, 0.80, rapidMix + 0.12 * sin(vWPlunge.y * 14.0 - tW * 4.0))
                             * smoothstep(0.04, 0.20, depth);

          // Gentle wispy bank froth only where moving water brushes the shore (no chalk line!)
          float bankBrush = (1.0 - smoothstep(0.03, 0.26, depth)) * smoothstep(0.008, 0.035, depth);
          float shoreWisps = bankBrush * smoothstep(0.48, 0.80, streak2) * (0.20 + 0.30 * rush);

          float foamAlpha = clamp(silkyThreads + cascadeFroth * 0.92 + plungeFroth * 0.62 + shoreWisps, 0.0, 0.94);

          // Warm cream sunlit froth & neutral misty sage-grey shaded froth (ZERO blue!)
          vec3 foamShade = vec3(0.48, 0.52, 0.46);
          vec3 foamSun   = vec3(0.95, 0.94, 0.87);
          vec3 foamCol   = mix(foamShade, foamSun, clamp(shadow * (0.72 + 0.28 * streak2) + 0.15 * streak1, 0.0, 1.0));

          // ---- 5. Smooth continuous sun glints (no grid floor() squares!) ----
          vec3 H = normalize(uSunDir + V);
          float NdotH = max(dot(wNormal, H), 0.0);
          float sunSheen = pow(NdotH, 36.0) * 0.28 * shadow * (1.0 - foamAlpha * 0.75);
          float waveGlint = smoothstep(0.76, 0.93, ng1.x * 0.5 + ng2.x * 0.5)
                          * pow(NdotH, 14.0) * 0.55 * shadow * (1.0 - foamAlpha * 0.8);
          waterCol += vec3(0.96, 0.92, 0.74) * (sunSheen + waveGlint);

          vec3 finalCol = mix(waterCol, foamCol, foamAlpha);

          // ---- 6. High clarity so the gravel streambed shines through everywhere ----
          float edgeFeather = smoothstep(-0.005, 0.085, vWDepth);
          float baseAlpha = mix(0.08, 0.38, smoothstep(0.04, 0.72, depth));
          float finalAlpha = clamp(baseAlpha + fresnel * 0.45 + foamAlpha * 0.82 + sunSheen * 0.3, 0.0, 0.95) * edgeFeather;

          gl_FragColor = vec4(finalCol, finalAlpha);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'cozy-clear-brook-water';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  return { mesh, uniforms };
}

// Soft, feathery white foam wakes wrapping emergent stones and trailing downstream.
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
      .replace('#include <common>', `#include <common>\n${GLSL_BROOK_COMMON}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float x = vWakeUv.x - 0.28;
          float y = (vWakeUv.y - 0.5) * 2.0;
          float tW = mod(uTime, 3600.0) + vWakePhase;

          float r = length(vec2(x * 1.2, y * 0.92));
          float n1 = wFlowFbm(vec2(x * 3.2, y * 4.6), -tW * 2.4);
          float n2 = wNoiseGrad(vec2(x * 6.5 - tW * 3.2, y * 5.8)).x;

          // Soft feathery upstream cushion wrapping the boulder
          float collar = smoothstep(0.14, 0.24, r) * (1.0 - smoothstep(0.28, 0.46, r))
                       * smoothstep(0.32, -0.14, x) * (0.45 + 0.55 * n1);

          // Silky downstream V-streaks fading naturally into the current
          float down = smoothstep(-0.08, 0.14, x) * (1.0 - smoothstep(0.25, 0.72, x));
          float armDist = abs(abs(y) - (0.22 + x * 0.55));
          float arms = (1.0 - smoothstep(0.02, 0.24 + x * 0.18, armDist)) * down
                     * smoothstep(0.32, 0.74, n1 * 0.6 + n2 * 0.5);

          float borderFade = smoothstep(0.0, 0.10, vWakeUv.x) * (1.0 - smoothstep(0.86, 1.0, vWakeUv.x))
                           * (1.0 - smoothstep(0.76, 0.98, abs(y)));

          float foam = clamp((collar * 0.85 + arms * 0.72) * borderFade, 0.0, 1.0);
          if (foam < 0.008) discard;

          float shadow = wSunShadow(reflectedLight);
          vec3 col = mix(vec3(0.50, 0.54, 0.48), vec3(0.95, 0.94, 0.88), clamp(shadow * 0.85 + 0.15 * n1, 0.0, 1.0));
          gl_FragColor = vec4(col, foam * 0.68);
        }`
      );
  };
  wakeMat.customProgramCacheKey = () => 'cozy-feathery-wake';

  const wakes = new THREE.InstancedMesh(wakeGeo, wakeMat, foamRings.length);
  wakes.receiveShadow = true;
  wakes.renderOrder = 3;

  const dummy = new THREE.Object3D();
  foamRings.forEach((r, i) => {
    dummy.position.set(r.x + r.dx * r.r * 0.52, r.y, r.z + r.dz * r.r * 0.52);
    dummy.rotation.set(0, Math.atan2(-r.dz, r.dx), 0);
    dummy.scale.set(r.r * 2.4, 1, r.r * 1.55);
    dummy.updateMatrix();
    wakes.setMatrixAt(i, dummy.matrix);
    phaseArr[i] = r.phase;
  });

  wakeGeo.setAttribute('aWakePhase', new THREE.InstancedBufferAttribute(phaseArr, 1));
  wakes.instanceMatrix.needsUpdate = true;
  wakes.computeBoundingSphere();
  return wakes;
}

// Soft drifting water-vapor & spray mist hovering over waterfalls and fast
// rocky riffles — a signature touch of Cozy Country's rushing brooks.
function buildStreamMist(uniforms, lateral) {
  const puffs = [];
  for (const d of DROPS) {
    const tCenter = tOfArc(d.u - DROP_LEN * 0.25);
    const hw = halfWidthAt(tCenter);
    const wy = waterSurfaceAt(tCenter);
    const count = 8;
    for (let k = 0; k < count; k++) {
      const lat = ((k + 0.5) / count - 0.5) * 2 * (hw * 0.82) + (Math.random() - 0.5) * 0.9;
      const tt = THREE.MathUtils.clamp(tCenter + tSpan((Math.random() - 0.5) * 3.2), 0, 1);
      const { x, z } = lateral(tt, lat);
      puffs.push({
        x,
        y: wy + 0.35 + Math.random() * 0.45,
        z,
        s: 1.5 + Math.random() * 1.4,
        phase: Math.random() * 6.28,
      });
    }
  }

  const geo = new THREE.PlaneGeometry(1, 1);
  const phaseArr = new Float32Array(puffs.length);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.userData.skipToon = true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = `
      attribute float aMistPhase;
      varying vec2 vMistUv;
      varying float vMistPhase;
      uniform float uTime;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vMistUv = uv;
       vMistPhase = aMistPhase;
       {
         // Camera-facing billboard with gentle rising/drifting motion
         float tW = mod(uTime, 3600.0);
         float cycle = fract(tW * 0.22 + aMistPhase);
         vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
         vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
         mat3 im = mat3(instanceMatrix);
         float sc = max(length(im[0]), 1e-3);
         vec2 corner = (uv - 0.5) * (0.85 + 0.45 * cycle);
         vec3 worldOff = camR * (corner.x * sc) + camU * (corner.y * sc * 0.72) + vec3(0.0, cycle * 0.55, 0.0);
         transformed = transpose(im) * worldOff / (sc * sc);
       }`
    );

    shader.fragmentShader = `
      uniform float uTime;
      varying vec2 vMistUv;
      varying float vMistPhase;
    ` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_BROOK_COMMON}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float tW = mod(uTime, 3600.0);
          float cycle = fract(tW * 0.22 + vMistPhase);
          float life = sin(cycle * 3.14159265);

          vec2 p = (vMistUv - 0.5) * 2.0;
          float r = length(p * vec2(0.9, 1.15));
          float wisp = wNoiseGrad(p * 1.8 + vec2(tW * 0.35 + vMistPhase * 3.1, -tW * 0.25)).x;
          float puff = (1.0 - smoothstep(0.15, 0.92, r - (wisp - 0.5) * 0.35)) * life;
          if (puff < 0.006) discard;

          float shadow = wSunShadow(reflectedLight);
          vec3 col = mix(vec3(0.58, 0.62, 0.56), vec3(0.96, 0.95, 0.89), 0.35 + 0.65 * shadow);
          gl_FragColor = vec4(col, puff * 0.22);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'cozy-brook-mist';

  const mesh = new THREE.InstancedMesh(geo, mat, puffs.length);
  mesh.receiveShadow = true;
  mesh.renderOrder = 4;

  const dummy = new THREE.Object3D();
  puffs.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(p.s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    phaseArr[i] = p.phase;
  });

  geo.setAttribute('aMistPhase', new THREE.InstancedBufferAttribute(phaseArr, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}
