import * as THREE from 'three';
import { streamCurve, levelAt, halfWidthAt, originalT } from './streamPath.js';
import { terrainHeight } from './terrain.js';

export function createGarden(scene) {
  const group = new THREE.Group();
  const lanternCores = [];
  const lanternLights = [];
  const lilyPads = [];

  const woodMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#7a5234'),
    roughness: 0.88,
    metalness: 0.0,
  });
  const darkWoodMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#4f3522'),
    roughness: 0.92,
    metalness: 0.0,
  });
  const stoneMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#8c8b82'),
    roughness: 0.94,
    metalness: 0.0,
  });
  const mossStoneMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#738068'),
    roughness: 0.95,
    metalness: 0.0,
  });
  const coreMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#fff2cc'),
    emissive: new THREE.Color('#ffb85c'),
    emissiveIntensity: 0.9,
    roughness: 0.4,
    userData: { noToon: true },
  });

  // Helper to get point & tangent frame along stream
  function frameAt(t) {
    const p = streamCurve.getPointAt(t);
    const tan = streamCurve.getTangentAt(t);
    const tl = Math.hypot(tan.x, tan.z) || 1;
    const tx = tan.x / tl, tz = tan.z / tl;
    const bx = -tz, bz = tx;
    return { p, tx, tz, bx, bz, lvl: levelAt(t), hw: halfWidthAt(t) };
  }

  // ---- 1. Arched Cedar Footbridge across the scenic narrow chute ----
  const bridgeT = originalT(0.495);
  {
    const { p, tx, tz, bx, bz, lvl, hw } = frameAt(bridgeT);
    const span = (hw + 2.4) * 2;
    const width = 2.3;
    const archHeight = 1.55;
    const bridge = new THREE.Group();
    bridge.position.set(p.x, lvl + 0.25, p.z);
    bridge.rotation.y = Math.atan2(bx, bz);

    const planks = 18;
    const plankGeo = new THREE.BoxGeometry(width, 0.12, span / planks * 0.86);
    for (let i = 0; i < planks; i++) {
      const u = (i + 0.5) / planks - 0.5;
      const zPos = u * span;
      const yPos = Math.cos(u * Math.PI) * archHeight;
      const slope = -Math.sin(u * Math.PI) * (archHeight * Math.PI / span);
      const plank = new THREE.Mesh(plankGeo, woodMat);
      plank.position.set(0, yPos, zPos);
      plank.rotation.x = -Math.atan(slope);
      plank.castShadow = true;
      plank.receiveShadow = true;
      bridge.add(plank);
    }

    // Side stringer beams & posts
    const postGeo = new THREE.BoxGeometry(0.16, 1.05, 0.16);
    const postIndices = [0, 4, 9, 13, 17];
    for (const side of [-1, 1]) {
      const xOff = side * (width * 0.5 - 0.12);
      const railPoints = [];
      for (const idx of postIndices) {
        const u = (idx + 0.5) / planks - 0.5;
        const zPos = u * span;
        const yPos = Math.cos(u * Math.PI) * archHeight;
        const post = new THREE.Mesh(postGeo, darkWoodMat);
        post.position.set(xOff, yPos + 0.5, zPos);
        post.castShadow = true;
        bridge.add(post);
        railPoints.push(new THREE.Vector3(xOff, yPos + 0.95, zPos));
      }
      const railCurve = new THREE.CatmullRomCurve3(railPoints);
      const railGeo = new THREE.TubeGeometry(railCurve, 20, 0.055, 6, false);
      const rail = new THREE.Mesh(railGeo, woodMat);
      rail.castShadow = true;
      bridge.add(rail);
    }
    group.add(bridge);
  }

  // ---- 2. Sculpted Stone Lanterns (Tōrō) ----
  function addLantern(x, z, scale = 1.0, addLight = false) {
    const y = terrainHeight(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.scale.setScalar(scale);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.56, 0.3, 6), mossStoneMat);
    base.position.y = 0.15;
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.1, 6), stoneMat);
    pillar.position.y = 0.85;
    pillar.castShadow = true;
    g.add(pillar);

    const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.28, 0.22, 6), mossStoneMat);
    platform.position.y = 1.48;
    platform.castShadow = true;
    g.add(platform);

    const core = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.36), coreMat);
    core.position.y = 1.8;
    g.add(core);
    lanternCores.push(core);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.68, 0.44, 6), mossStoneMat);
    roof.position.y = 2.22;
    roof.castShadow = true;
    g.add(roof);

    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), stoneMat);
    finial.position.y = 2.48;
    g.add(finial);

    if (addLight) {
      const pt = new THREE.PointLight('#ffb866', 0.8, 18, 1.8);
      pt.position.set(0, 1.8, 0);
      g.add(pt);
      lanternLights.push(pt);
    }

    group.add(g);
  }

  // Place lanterns near bridge approaches & lakeside
  {
    const fBridge = frameAt(bridgeT);
    const off = fBridge.hw + 3.4;
    addLantern(fBridge.p.x + fBridge.bx * off + fBridge.tx * 2.2, fBridge.p.z + fBridge.bz * off + fBridge.tz * 2.2, 0.95, true);
    addLantern(fBridge.p.x - fBridge.bx * off - fBridge.tx * 2.2, fBridge.p.z - fBridge.bz * off - fBridge.tz * 2.2, 0.95, true);

    const fLake = frameAt(originalT(0.42));
    addLantern(fLake.p.x - fLake.bx * (fLake.hw + 3.6), fLake.p.z - fLake.bz * (fLake.hw + 3.6), 1.05, true);

    const fPool = frameAt(originalT(0.365));
    addLantern(fPool.p.x - fPool.bx * (fPool.hw + 3.2), fPool.p.z - fPool.bz * (fPool.hw + 3.2), 0.9, false);
  }

  // ---- 3. Mossy Stepping-Stone Garden Path along the lakeside ----
  {
    const stoneGeo = new THREE.CylinderGeometry(0.65, 0.72, 0.16, 7);
    const steps = 16;
    const stones = new THREE.InstancedMesh(stoneGeo, mossStoneMat, steps);
    stones.receiveShadow = true;
    stones.castShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < steps; i++) {
      const t = THREE.MathUtils.lerp(originalT(0.38), originalT(0.49), i / (steps - 1));
      const f = frameAt(t);
      const lat = -(f.hw + 2.8 + Math.sin(i * 0.9) * 0.7);
      const x = f.p.x + f.bx * lat;
      const z = f.p.z + f.bz * lat;
      const y = terrainHeight(x, z);
      dummy.position.set(x, y + 0.04, z);
      dummy.rotation.set((Math.random() - 0.5) * 0.08, Math.random() * Math.PI, (Math.random() - 0.5) * 0.08);
      const s = 0.85 + Math.random() * 0.4;
      dummy.scale.set(s, 1, s * (0.75 + Math.random() * 0.35));
      dummy.updateMatrix();
      stones.setMatrixAt(i, dummy.matrix);
    }
    stones.instanceMatrix.needsUpdate = true;
    group.add(stones);
  }

  // ---- 4. Timber Garden Bench overlooking the main lake ----
  {
    const f = frameAt(originalT(0.42));
    const lat = -(f.hw + 4.4);
    const bx = f.p.x + f.bx * lat;
    const bz = f.p.z + f.bz * lat;
    const by = terrainHeight(bx, bz);
    const bench = new THREE.Group();
    bench.position.set(bx, by, bz);
    bench.rotation.y = Math.atan2(f.bx, f.bz);

    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.72), woodMat);
    seat.position.y = 0.52;
    seat.castShadow = true;
    seat.receiveShadow = true;
    bench.add(seat);

    const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.48, 0.1), woodMat);
    back.position.set(0, 0.88, -0.32);
    back.rotation.x = -0.14;
    back.castShadow = true;
    bench.add(back);

    const legGeo = new THREE.BoxGeometry(0.14, 0.52, 0.62);
    for (const sx of [-0.95, 0.95]) {
      const leg = new THREE.Mesh(legGeo, darkWoodMat);
      leg.position.set(sx, 0.26, 0);
      leg.castShadow = true;
      bench.add(leg);
    }
    group.add(bench);
  }

  // ---- 5. Floating Waterlilies & Lotus Blossoms on calm pools ----
  {
    const padGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.025, 14, 1, false, 0, Math.PI * 1.82);
    const padMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#3f7a44'),
      roughness: 0.72,
    });
    const lotusMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#f7bfd0'),
      emissive: new THREE.Color('#662238'),
      emissiveIntensity: 0.12,
      roughness: 0.5,
    });
    const petalGeo = new THREE.ConeGeometry(0.08, 0.22, 5);

    const clusters = [
      { t: originalT(0.415), lat: -4.8, count: 7 },
      { t: originalT(0.435), lat: 5.2, count: 6 },
      { t: originalT(0.16), lat: 2.2, count: 5 },
      { t: originalT(0.70), lat: -3.5, count: 6 },
    ];

    for (const cl of clusters) {
      const f = frameAt(cl.t);
      for (let i = 0; i < cl.count; i++) {
        const px = f.p.x + f.bx * cl.lat + (Math.random() - 0.5) * 3.8;
        const pz = f.p.z + f.bz * cl.lat + (Math.random() - 0.5) * 3.8;
        const padGroup = new THREE.Group();
        const baseY = f.lvl + 0.025;
        padGroup.position.set(px, baseY, pz);
        padGroup.rotation.y = Math.random() * Math.PI * 2;
        const sc = 0.75 + Math.random() * 0.65;
        padGroup.scale.setScalar(sc);

        const pad = new THREE.Mesh(padGeo, padMat);
        pad.receiveShadow = true;
        padGroup.add(pad);

        if (i % 2 === 0) {
          const flower = new THREE.Group();
          flower.position.y = 0.04;
          for (let p = 0; p < 6; p++) {
            const ang = (p / 6) * Math.PI * 2;
            const petal = new THREE.Mesh(petalGeo, lotusMat);
            petal.position.set(Math.cos(ang) * 0.06, 0.06, Math.sin(ang) * 0.06);
            petal.rotation.z = -Math.cos(ang) * 0.55;
            petal.rotation.x = Math.sin(ang) * 0.55;
            flower.add(petal);
          }
          padGroup.add(flower);
        }

        group.add(padGroup);
        lilyPads.push({ mesh: padGroup, baseY, phase: Math.random() * Math.PI * 2 });
      }
    }
  }

  scene.add(group);

  return {
    group,
    update(t, lanternGlow = 0.85) {
      coreMat.emissiveIntensity = lanternGlow;
      for (const pt of lanternLights) {
        pt.intensity = lanternGlow * 0.95;
      }
      for (const lp of lilyPads) {
        lp.mesh.position.y = lp.baseY + Math.sin(t * 1.6 + lp.phase) * 0.015;
        lp.mesh.rotation.z = Math.sin(t * 1.2 + lp.phase) * 0.025;
      }
    },
  };
}
