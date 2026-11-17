import * as THREE from 'three';

// A mountain brook: strongly meandering in plan, terraced in elevation.
// t=1 is upstream (far, high); the water steps down pool-by-pool toward t=0,
// flowing toward (and past) the camera like the reference footage.
export const STREAM_HALF_WIDTH = 28.0; // widest half-width (~56m wide open pools)

// The nine control points the scene was composed around. Not to be edited: the
// opening shot, the lake, the hero boulders and every tuned drop height are all
// framed against this exact geometry.
const ORIGINAL = [
  [-150, 14],
  [-110, -8],
  [-70, -20],
  [-40, -8],
  [-10, -22],
  [30, -8],
  [70, -26],
  [110, -10],
  [150, -20],
];

// The brook continues past both ends of the original reach, at the same ~40-unit
// control spacing and the same meander amplitude, so the extension is the same
// river rather than a different one bolted on.
const DOWNSTREAM = [
  [-470, 6],
  [-430, -12],
  [-390, 4],
  [-350, -16],
  [-310, 10],
  [-270, -14],
  [-230, 2],
  [-190, -10],
];
const UPSTREAM = [
  [190, 4],
  [230, -14],
  [270, 8],
  [310, -12],
  [350, 2],
  [390, -18],
  [430, 6],
  [470, -8],
];

const points = [...DOWNSTREAM, ...ORIGINAL, ...UPSTREAM]
  .map(([x, z]) => new THREE.Vector3(x, 0, z));

export const streamCurve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);

// Total length in world units — the profile below is authored in these units
// rather than in t, so lengthening the curve cannot move existing features.
export const STREAM_LENGTH = streamCurve.getLength();

// Sample density matches the original (300 samples over ~326 units), so the
// nearest-sample search keeps the same spatial resolution on a 3.2x longer curve.
const N = Math.round(300 * (STREAM_LENGTH / 326.409));
export const streamSamples = streamCurve.getSpacedPoints(N);

const SAMPLE_X = new Float64Array(streamSamples.length);
const SAMPLE_Z = new Float64Array(streamSamples.length);
for (let i = 0; i < streamSamples.length; i++) {
  SAMPLE_X[i] = streamSamples[i].x;
  SAMPLE_Z[i] = streamSamples[i].z;
}

// ---- where the original reach now sits ----
const ORIGIN_T = 0.34537947; // t of the original curve's start point
const ORIGIN_SPAN_T = 0.31009945; // t occupied by the original reach
const ORIGIN_U = ORIGIN_T * STREAM_LENGTH;
const ORIGIN_SPAN = ORIGIN_SPAN_T * STREAM_LENGTH;
const ORIGIN_END = ORIGIN_U + ORIGIN_SPAN;

const fromOriginal = (tOld) => ORIGIN_U + tOld * ORIGIN_SPAN;

// ---- terraced elevation profile ----
const ORIGINAL_DROPS = [
  { t: 0.10, h: 1.6 },
  { t: 0.22, h: 1.5 },
  { t: 0.32, h: 1.8 },
  { t: 0.52, h: 2.2 }, // taller step out of the wide pool
  { t: 0.64, h: 1.6 },
  { t: 0.76, h: 1.7 },
  { t: 0.88, h: 1.6 },
];

export const DROP_LEN = 0.008 * ORIGIN_SPAN;

const DROP_STEP = 39.15;
const END_MARGIN = 14;
const REACH_CLEARANCE = 6;
const NEW_DROP_H = [1.6, 1.5, 1.8, 2.0, 1.5, 1.7, 1.6, 2.2];

export const DROPS = (() => {
  const list = ORIGINAL_DROPS.map((d) => ({ u: fromOriginal(d.t), h: d.h }));
  const first = list[0].u;
  const last = list[list.length - 1].u;
  for (let k = 1; ; k++) {
    const u = first - k * DROP_STEP;
    if (u < END_MARGIN) break;
    if (u + DROP_LEN > ORIGIN_U - REACH_CLEARANCE) continue;
    list.push({ u, h: NEW_DROP_H[(k - 1) % NEW_DROP_H.length] });
  }
  for (let k = 1; ; k++) {
    const u = last + k * DROP_STEP;
    if (u > STREAM_LENGTH - END_MARGIN) break;
    if (u - DROP_LEN < ORIGIN_END + REACH_CLEARANCE) continue;
    list.push({ u, h: NEW_DROP_H[(k + 3) % NEW_DROP_H.length] });
  }
  return list.sort((a, b) => a.u - b.u);
})();

const TOTAL_DROP = DROPS.reduce((a, d) => a + d.h, 0);
const SOURCE_LEVEL = -0.4 - DROPS.filter((d) => d.u < ORIGIN_U).reduce((a, d) => a + d.h, 0);

const arcOf = (t) => t * STREAM_LENGTH;
export const tOfArc = (u) => THREE.MathUtils.clamp(u / STREAM_LENGTH, 0, 1);
export const tSpan = (units) => units / STREAM_LENGTH;

export function levelSmoothAt(t) {
  return SOURCE_LEVEL + TOTAL_DROP * t;
}

export function levelAt(t) {
  const u = arcOf(t);
  let lvl = SOURCE_LEVEL;
  for (const d of DROPS) {
    if (u > d.u + DROP_LEN * 0.5) {
      lvl += d.h;
    } else if (u > d.u - DROP_LEN * 0.5) {
      const k = (u - (d.u - DROP_LEN * 0.5)) / DROP_LEN;
      lvl += d.h * (k * k * (3 - 2 * k));
    }
  }
  return lvl;
}

export function cascadeAt(t) {
  const u = arcOf(t);
  let s = 0;
  for (const d of DROPS) {
    const q = (u - d.u) / DROP_LEN;
    let v = 0;
    if (q >= -0.5 && q <= 0.7) v = 1;
    else if (q < -0.5 && q > -1.6) v = 1 - (-q - 0.5) / 1.1;
    else if (q > 0.7 && q < 1.1) v = 1 - (q - 0.7) / 0.4;
    s = Math.max(s, v);
  }
  return s;
}

// Generous 2x wider variable-width river:
// - Narrowest waterfall chutes & swift riffle runs sit around ~13m–22m wide (never cramped!)
// - Wide sunlit stream basins open out generously to ~44m–56m wide
const ORIGINAL_POOLS = [
  { t: 0.05, w: 14.5, s: 0.033 },  // ~44m lower pool
  { t: 0.16, w: 18.2, s: 0.037 },  // ~52m wide downstream basin
  { t: 0.27, w: 3.1, s: 0.026 },   // ~21m swift rocky run below waterfall
  { t: 0.425, w: 20.4, s: 0.055 }, // ~56m wide sunlit basin in opening view
  { t: 0.58, w: 2.9, s: 0.026 },   // ~21m swift riffle run above waterfall
  { t: 0.70, w: 18.6, s: 0.037 },  // ~52m wide upper basin
  { t: 0.82, w: 3.5, s: 0.027 },   // ~22m upper rocky run
  { t: 0.94, w: 16.4, s: 0.035 },  // ~48m wide headwater pool
];

const MIN_POOL_CLEARANCE = 1.42;

const POOLS = (() => {
  const list = ORIGINAL_POOLS.map((p) => ({
    u: fromOriginal(p.t), w: p.w, s: p.s * ORIGIN_SPAN,
  }));
  const shapes = list.map(({ w, s }) => ({ w, s }));

  let picked = 0;
  for (let i = 0; i < DROPS.length - 1; i++) {
    const u = (DROPS[i].u + DROPS[i + 1].u) / 2;
    if (u > ORIGIN_U && u < ORIGIN_END) continue;
    const halfGap = (DROPS[i + 1].u - DROPS[i].u) / 2;
    const fits = shapes.filter((sh) => halfGap / sh.s >= MIN_POOL_CLEARANCE
      && !(u < ORIGIN_U && u + 2.6 * sh.s > ORIGIN_U)
      && !(u > ORIGIN_END && u - 2.6 * sh.s < ORIGIN_END));
    if (!fits.length) continue;
    list.push({ u, ...fits[picked++ % fits.length] });
  }
  return list.sort((a, b) => a.u - b.u);
})();

const NECK = 7.6; // half-width of narrow chutes (~15.2m full throat width — 2.2x previous!)
const OPEN = 24.0; // calm wide pool threshold
const WOBBLE_FREQ = 23.0 / ORIGIN_SPAN;

export function halfWidthAt(t) {
  const u = arcOf(t);
  let hw = NECK;
  for (const p of POOLS) {
    const d = (u - p.u) / p.s;
    hw += p.w * Math.exp(-d * d);
  }
  const sillDamp = 1 - cascadeAt(t) * 0.85;
  const wobble = (
    1.35 * Math.sin((u - ORIGIN_U) * WOBBLE_FREQ + 1.2)
    + 0.85 * Math.cos((u - ORIGIN_U) * WOBBLE_FREQ * 0.41 - 0.7)
  ) * sillDamp;
  return Math.max(6.4, hw + wobble);
}

// 0 = open pool, 1 = narrowest chute (extra rushing foam there)
export function narrownessAt(t) {
  return THREE.MathUtils.clamp(1 - (halfWidthAt(t) - NECK) / (OPEN - NECK), 0, 1);
}

export const originalT = (tOld) => fromOriginal(tOld) / STREAM_LENGTH;

export const HOME_T = originalT(0.36);
export const LOOK_T = originalT(0.58);

const COARSE = 8;
const SEARCH_HALF = COARSE >> 1;

const MAX_STEP = (() => {
  let m = 0;
  for (let i = 1; i < SAMPLE_X.length; i++) {
    m = Math.max(m, Math.hypot(SAMPLE_X[i] - SAMPLE_X[i - 1], SAMPLE_Z[i] - SAMPLE_Z[i - 1]));
  }
  return m;
})();
const SLACK = SEARCH_HALF * MAX_STEP;

const NODES = (() => {
  const a = [];
  for (let i = 0; i < SAMPLE_X.length; i += COARSE) a.push(i);
  if (a[a.length - 1] !== SAMPLE_X.length - 1) a.push(SAMPLE_X.length - 1);
  return Int32Array.from(a);
})();
const NODE_D2 = new Float64Array(NODES.length);

export function streamAt(x, z) {
  const nNodes = NODES.length;

  let bound2 = Infinity;
  for (let k = 0; k < nNodes; k++) {
    const i = NODES[k];
    const dx = x - SAMPLE_X[i];
    const dz = z - SAMPLE_Z[i];
    const d = dx * dx + dz * dz;
    NODE_D2[k] = d;
    if (d < bound2) bound2 = d;
  }

  const cut = Math.sqrt(bound2) + SLACK;
  const cut2 = cut * cut;
  const last = SAMPLE_X.length - 1;
  let min = Infinity;
  let ti = 0;
  for (let k = 0; k < nNodes; k++) {
    if (NODE_D2[k] > cut2) continue;
    const j = NODES[k];
    const lo = j - SEARCH_HALF < 0 ? 0 : j - SEARCH_HALF;
    const hi = j + SEARCH_HALF > last ? last : j + SEARCH_HALF;
    for (let i = lo; i <= hi; i++) {
      const dx = x - SAMPLE_X[i];
      const dz = z - SAMPLE_Z[i];
      const d = dx * dx + dz * dz;
      if (d < min) { min = d; ti = i; }
    }
  }

  const t = ti / last;
  const raw = Math.sqrt(min);
  const d = raw + Math.sin(x * 0.16) * 0.9 + Math.cos(z * 0.2) * 0.7;
  return { d, t, raw };
}

export const WATER_EDGE_PAD = 2.5;

export function inWater(x, z, margin = 1.0) {
  const { t, raw } = streamAt(x, z);
  return raw < halfWidthAt(t) + WATER_EDGE_PAD + margin;
}

export function waterLevelAt(x, z) {
  return levelAt(streamAt(x, z).t);
}

export function distToStream(x, z) {
  return streamAt(x, z).d;
}
