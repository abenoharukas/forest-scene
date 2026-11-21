import * as THREE from 'three';

export const ATMOSPHERES = {
  golden: {
    label: 'Golden Hour',
    skyTop: new THREE.Color('#4b8fce'),
    skyMid: new THREE.Color('#a8d0e4'),
    skyBottom: new THREE.Color('#f7c983'),
    sun: new THREE.Color('#ffd9a0'),
    sunIntensity: 3.2,
    sunPos: new THREE.Vector3(60, 92, -120),
    ambSky: new THREE.Color('#a8bfe8'),
    ambGround: new THREE.Color('#8a7a4a'),
    hemiIntensity: 1.3,
    ambientIntensity: 0.34,
    exposure: 1.32,
    lanternGlow: 0.85,
  },
  morning: {
    label: 'Morning Mist',
    skyTop: new THREE.Color('#6b9ec9'),
    skyMid: new THREE.Color('#cbe2ea'),
    skyBottom: new THREE.Color('#f4dcd0'),
    sun: new THREE.Color('#fff0dc'),
    sunIntensity: 2.6,
    sunPos: new THREE.Vector3(-85, 68, -110),
    ambSky: new THREE.Color('#c2d6eb'),
    ambGround: new THREE.Color('#7a8768'),
    hemiIntensity: 1.45,
    ambientIntensity: 0.42,
    exposure: 1.26,
    lanternGlow: 0.45,
  },
  noon: {
    label: 'Sunlit Noon',
    skyTop: new THREE.Color('#2f78c4'),
    skyMid: new THREE.Color('#8ac4e8'),
    skyBottom: new THREE.Color('#d8eef5'),
    sun: new THREE.Color('#fff8eb'),
    sunIntensity: 3.4,
    sunPos: new THREE.Vector3(35, 165, -75),
    ambSky: new THREE.Color('#b6d4f2'),
    ambGround: new THREE.Color('#7d8b58'),
    hemiIntensity: 1.25,
    ambientIntensity: 0.36,
    exposure: 1.2,
    lanternGlow: 0.15,
  },
  twilight: {
    label: 'Twilight',
    skyTop: new THREE.Color('#192447'),
    skyMid: new THREE.Color('#4c4f7a'),
    skyBottom: new THREE.Color('#d9886a'),
    sun: new THREE.Color('#ff9d70'),
    sunIntensity: 1.45,
    sunPos: new THREE.Vector3(90, 32, -140),
    ambSky: new THREE.Color('#6374a6'),
    ambGround: new THREE.Color('#3b3c4d'),
    hemiIntensity: 1.15,
    ambientIntensity: 0.42,
    exposure: 1.18,
    lanternGlow: 3.4,
  },
};

const PALETTE = {
  skyTop: ATMOSPHERES.golden.skyTop.clone(),
  skyMid: ATMOSPHERES.golden.skyMid.clone(),
  skyBottom: ATMOSPHERES.golden.skyBottom.clone(),
  sun: ATMOSPHERES.golden.sun.clone(),
  ambSky: ATMOSPHERES.golden.ambSky.clone(),
  ambGround: ATMOSPHERES.golden.ambGround.clone(),
};

const SHADOW_EXTENT = 110;
const SHADOW_BACK_OFF = 260;

export function createWorld(scene) {
  scene.background = PALETTE.skyBottom.clone();

  const sky = makeSkyDome();
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(PALETTE.ambSky, PALETTE.ambGround, ATMOSPHERES.golden.hemiIntensity);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(new THREE.Color('#cdd4ea'), ATMOSPHERES.golden.ambientIntensity);
  scene.add(ambient);

  const sunPos = ATMOSPHERES.golden.sunPos.clone();
  const sun = new THREE.DirectionalLight(PALETTE.sun, ATMOSPHERES.golden.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const s = SHADOW_EXTENT;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SHADOW_BACK_OFF * 2;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.2;
  scene.add(sun);
  scene.add(sun.target);

  const sunDir = sunPos.clone().normalize();
  const targetPreset = { ...ATMOSPHERES.golden };
  let currentKey = 'golden';
  let currentLanternGlow = ATMOSPHERES.golden.lanternGlow;

  const aim = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function followSky(camera) {
    sky.position.set(camera.position.x, 0, camera.position.z);
  }

  function focusShadow(camera) {
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    aim.copy(camera.position).addScaledVector(fwd, SHADOW_EXTENT * 0.55);
    aim.y = 0;
    sun.target.position.copy(aim);
    sun.target.updateMatrixWorld();
    sun.position.copy(aim).addScaledVector(sunDir, SHADOW_BACK_OFF);
    sun.updateMatrixWorld();
    sun.shadow.camera.updateProjectionMatrix();
  }

  function setAtmosphere(key) {
    if (!ATMOSPHERES[key]) return;
    currentKey = key;
    Object.assign(targetPreset, ATMOSPHERES[key]);
  }

  function updateAtmosphere(dt, renderer) {
    const k = 1 - Math.exp(-dt * 2.8);
    PALETTE.skyTop.lerp(targetPreset.skyTop, k);
    PALETTE.skyMid.lerp(targetPreset.skyMid, k);
    PALETTE.skyBottom.lerp(targetPreset.skyBottom, k);
    PALETTE.sun.lerp(targetPreset.sun, k);
    PALETTE.ambSky.lerp(targetPreset.ambSky, k);
    PALETTE.ambGround.lerp(targetPreset.ambGround, k);

    scene.background.copy(PALETTE.skyBottom);
    sky.material.uniforms.top.value.copy(PALETTE.skyTop);
    sky.material.uniforms.mid.value.copy(PALETTE.skyMid);
    sky.material.uniforms.bottom.value.copy(PALETTE.skyBottom);

    sun.color.copy(PALETTE.sun);
    sun.intensity = THREE.MathUtils.lerp(sun.intensity, targetPreset.sunIntensity, k);
    sunPos.lerp(targetPreset.sunPos, k);
    sunDir.copy(sunPos).normalize();

    hemi.color.copy(PALETTE.ambSky);
    hemi.groundColor.copy(PALETTE.ambGround);
    hemi.intensity = THREE.MathUtils.lerp(hemi.intensity, targetPreset.hemiIntensity, k);
    ambient.intensity = THREE.MathUtils.lerp(ambient.intensity, targetPreset.ambientIntensity, k);
    if (renderer) {
      renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, targetPreset.exposure, k);
    }
    currentLanternGlow = THREE.MathUtils.lerp(currentLanternGlow, targetPreset.lanternGlow, k);
  }

  return {
    sun,
    sunPos,
    sunDir,
    hemi,
    PALETTE,
    focusShadow,
    followSky,
    setAtmosphere,
    updateAtmosphere,
    getAtmosphereKey: () => currentKey,
    getLanternGlow: () => currentLanternGlow,
    SHADOW_EXTENT,
  };
}

const SKY_RADIUS = 1200;

function makeSkyDome() {
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: PALETTE.skyTop },
      mid: { value: PALETTE.skyMid },
      bottom: { value: PALETTE.skyBottom },
    },
    vertexShader: `
      varying float vH;
      void main() {
        vH = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying float vH;
      uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
      void main() {
        float h = clamp(vH, 0.0, 1.0);
        vec3 c = mix(bottom, mid, smoothstep(0.0, 0.2, h));
        c = mix(c, top, smoothstep(0.13, 0.55, h));
        c = mix(c, bottom, smoothstep(0.0, -0.05, vH));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}
