import * as THREE from 'three';
import { streamAt, levelAt, levelSmoothAt, halfWidthAt, waterLevelAt } from './streamPath.js';

// Smooth deterministic multi-scale woodland canopy density across the whole world.
// Alternates lush dense forest stands (~1.15–1.32) with airy sunlit sparser glades
// (~0.28–0.42), never dropping to zero so no region of the map is left as bald grass.
export function woodlandDensity(x, z) {
  // Macro grove / clearing rhythm (~220m–320m wavelength)
  const macro = Math.sin(x * 0.019 + z * 0.014 + 0.8) * 0.5
              + Math.cos(x * 0.013 - z * 0.021 - 1.4) * 0.5;
  // Meso stand / clump structure (~75m–110m wavelength)
  const meso = Math.sin(x * 0.058 - z * 0.047 + 2.3) * 0.5
             + Math.cos(x * 0.043 + z * 0.064 - 0.6) * 0.5;
  const raw = 0.5 + 0.34 * macro + 0.22 * meso;
  return 0.28 + 1.04 * smoothstep(0.12, 0.88, raw);
}

// A terraced brook valley: the floor follows the stream's stepped elevation
// profile, so the whole scene descends downstream. Referencing valley slopes to
// shoreline distance (d - bed) keeps wide 25m pools and narrow 5.5m chutes equally
// well-banked without submerging wide-pool shores.
export function terrainHeight(x, z) {
  const { d, t } = streamAt(x, z);
  const bed = halfWidthAt(t);
  const bankDist = Math.max(0, d - bed);
  const lvlSharp = levelAt(t);

  // terrace steps hug the local shoreline; hillsides follow the smooth valley grade
  const lvl = THREE.MathUtils.lerp(lvlSharp, levelSmoothAt(t), smoothstep(4, 24, bankDist));

  // valley sides climbing away from the local shoreline
  let h = lvl + 0.85 + 15.0 * smoothstep(4, 88, bankDist);

  // fine roughness, damped right next to the water
  const rough = 0.28 + 0.72 * smoothstep(2, 16, bankDist);
  h += (Math.sin(x * 0.045) * 1.1 + Math.cos(z * 0.05) * 0.9 + Math.sin(x * 0.13 + z * 0.11) * 0.5) * rough;

  // broad grassy knolls + rolling upland hills across the outer map
  h += Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.024 + 0.5) * 2.6 * smoothstep(7, 28, bankDist);
  h += Math.sin(x * 0.0085 - 0.7) * Math.cos(z * 0.0095 + 1.1) * 3.8 * smoothstep(35, 130, bankDist);

  // carve a shallow natural gravel brook channel below the local waterline
  const bank = bed + 4.5;
  if (d < bank) {
    const k = THREE.MathUtils.clamp((bank - d) / (bank - bed), 0, 1);
    const centerDepth = 0.96 + 0.22 * smoothstep(6.5, 22.0, bed);
    h = THREE.MathUtils.lerp(h, lvlSharp - centerDepth, smoothstep(0.08, 1.0, k));
  }
  return h;
}

export function isLand(x, z, margin = 0.8) {
  return terrainHeight(x, z) > waterLevelAt(x, z) + margin;
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
