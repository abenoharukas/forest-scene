import * as THREE from 'three';

const LIT = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial']);

const DEFAULTS = {
  edge: 0.2,
  width: 0.1,
  shadow: new THREE.Color('#b4bfdb'),
  shadowLevel: 1.5,
  warm: new THREE.Color('#ffe6b8'),
  litBoost: 1.16,
  rim: 0.62,
  rimPower: 2.4,
  rimColor: new THREE.Color('#ffdca4'),
  sat: 1.15,
  floor: 0,
};

const done = new Set();

function toonifyOne(mat, p) {
  // skipToon: HEAD's opt-out flag. noToon: the patch's flag for the same idea
  // (garden lantern glow / emissive meshes). Both are honoured so the two
  // generations of code agree.
  if (!mat || done.has(mat) || mat.userData?.skipToon || mat.userData?.noToon || !LIT.has(mat.type)) return;
  done.add(mat);
  patch(mat, mat.userData.canopy ? { ...p, shadowLevel: p.shadowLevel * 1.2, floor: 0.34 } : p);
  mat.roughness = 1;
  mat.metalness = 0;
}

export function toonifyMaterials(mats, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  for (const mat of mats) toonifyOne(mat, p);
}

export function toonify(scene, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  scene.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const mat of mats) toonifyOne(mat, p);
  });
}

function patch(mat, p) {
  const c = (col) => `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})`;

  const chunk = /* glsl */ `
    {
      float dl = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722));
      float il = dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722));
      float t = dl / (dl + il + 1e-4);
      float k = smoothstep(${(p.edge - p.width).toFixed(4)}, ${(p.edge + p.width).toFixed(4)}, t);

      vec3 sun = reflectedLight.directDiffuse * min(${p.litBoost.toFixed(3)} * k / max(t, 0.14), 3.2);
      reflectedLight.directDiffuse = sun * ${c(p.warm)};
      reflectedLight.indirectDiffuse *= mix(${c(p.shadow)} * ${p.shadowLevel.toFixed(3)}, vec3(1.0), k);

      float rim = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), ${p.rimPower.toFixed(2)});
      reflectedLight.directDiffuse += ${c(p.rimColor)} * (rim * ${p.rim.toFixed(3)} * (0.25 + 0.75 * k)) * diffuseColor.rgb;
      reflectedLight.indirectDiffuse += diffuseColor.rgb * ${p.floor.toFixed(3)};

      vec3 tot = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
      float grey = dot(tot, vec3(0.2126, 0.7152, 0.0722));
      vec3 boosted = max(mix(vec3(grey), tot, ${p.sat.toFixed(3)}), vec3(0.0));
      reflectedLight.directDiffuse = boosted;
      reflectedLight.indirectDiffuse = vec3(0.0);
    }
  `;

  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prevCompile) prevCompile.call(this, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      '#include <lights_fragment_end>\n' + chunk
    );
  };
  mat.customProgramCacheKey = function () {
    return `toon2-${p.edge}-${p.rim}-${p.floor}-${p.shadowLevel}-${prevKey ? prevKey.call(this) : mat.type}`;
  };
  mat.needsUpdate = true;
}
