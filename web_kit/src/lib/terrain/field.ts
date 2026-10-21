/**
 * Terrain's land: the pure rule that turns one history sample into one ROW of the heightfield, and the constants that tie
 * time to distance. No clock, no DOM, no GPU: everything here is unit-tested in Node.
 *
 * A row is a lateral cross-section of the land at one instant of the playhead. It is computed ONCE, when the sample is
 * recorded, and then stored (history.ts). The shader only displaces the mesh by the stored heights, so a later change in the
 * music can never rewrite the shape of the past: that is what makes the landscape a memory and not a moving picture.
 *
 * A row carries four height parts, kept separate so the shader can tint by register and the tests can assert each:
 *   bass  broad, deep elevation: a central ridge that meanders slowly with time, plus lower flank ridges; a bass hit widens
 *         and lifts it (amber)
 *   mid   rolling valleys: long-wavelength sinusoids whose phase drifts with time, zero-mean so they cut valleys as well as
 *         raise swells (cyan)
 *   high  micro-crests: sharp ridged fine detail across the whole width (violet)
 *   scar  the mark of a detected onset: a thin transverse crease across the whole row, deposited only on the row that
 *         recorded the onset (it stays in the land; the travelling shockwave is separate, see `shockWave`)
 * `rmsEnergy` is deliberately absent: loudness lights the land (scene.ts) and never reshapes it.
 *
 * Gains are PROPOSED starting values for visual review.
 */

/** Columns across the width of the land (vertices per row). */
export const COLS = 128;
/** Rows kept in the ring (vertices along the depth). */
export const ROWS = 160;
/** Minimum playhead advance between rows. 50 ms is longer than twice the 23.2 ms offline analysis hop. */
export const STEP_S = 0.05;
/** Seconds of history on screen: from the newest row to the oldest. */
export const WINDOW_S = (ROWS - 1) * STEP_S;
/** World units of depth per second of history: the time-to-distance mapping, linear. */
export const UNITS_PER_S = 1.6;
/** Half the width of the land in world units. */
export const HALF_WIDTH = 9;
/** Total depth of the land in world units. */
export const DEPTH = WINDOW_S * UNITS_PER_S;

export const BASS_GAIN = 1.7;
export const HIT_GAIN = 0.7;
export const MID_GAIN = 0.95;
export const HIGH_GAIN = 0.3;
export const SCAR_GAIN = 0.9;

/** Shockwave: travels backward through the land faster than the land recedes. */
export const WAVE_SPEED = 3.2; // extra world units per second on top of UNITS_PER_S
export const WAVE_LIFE_S = 1.8;
export const WAVE_AMP = 0.55;
export const WAVE_WIDTH = 1.5;
export const WAVE_K = 5.5;
export const WAVE_SLOTS = 8;

export interface RowInput {
  /** Playhead time of the sample, seconds. */
  t: number;
  bass: number;
  mid: number;
  high: number;
  /** `bassHit`, 0..1. */
  hit: number;
  /** Strongest onset (0..1) recorded since the previous row, or 0. */
  shock: number;
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** Lateral coordinate of column c in -1..1. */
export const colX = (c: number): number => (c / (COLS - 1)) * 2 - 1;

/** Soft lateral border: 1 across the land, 0 at |x| = 1. */
export const taper = (x: number): number => 1 - smoothstep(0.78, 1.0, Math.abs(x));

/** The four parts of the height of column `c` of a row, written to `out[o..o+3]` as (bass, mid, high, scar). */
export function heightParts(inp: RowInput, c: number, out: Float32Array, o: number): void {
  const x = colX(c);
  const t = inp.t;
  const k = taper(x);

  // bass: a central ridge that meanders and widens on a hit, plus two lower flank ridges.
  const cx = 0.16 * Math.sin(0.31 * t);
  const w = 0.32 + 0.1 * inp.hit;
  const d = (x - cx) / w;
  const ridge = Math.exp(-d * d);
  const f = (Math.abs(x) - 0.72) / 0.2;
  const flank = 0.36 * Math.exp(-f * f) * (0.7 + 0.3 * Math.sin(0.17 * t + 1));
  const hb = inp.bass * BASS_GAIN * (ridge + flank) + inp.hit * HIT_GAIN * ridge * ridge;

  // mid: rolling valleys, zero mean.
  const hm = inp.mid * MID_GAIN * (0.55 * Math.sin(2.9 * x + 0.54 * t) + 0.3 * Math.sin(6.1 * x - 0.47 * t + 1.3));

  // high: sharp ridged micro-crests.
  const r1 = 1 - Math.abs(Math.sin(29 * x + 5.1 * t));
  const r2 = 1 - Math.abs(Math.sin(47 * x - 8.3 * t + 2));
  const hh = inp.high * HIGH_GAIN * (0.6 * r1 * r1 + 0.4 * r2 * r2);

  // scar: a transverse crease, a little stronger down the middle.
  const hs = inp.shock * SCAR_GAIN * (0.55 + 0.45 * Math.exp(-(x * x) / 0.36));

  out[o] = hb * k;
  out[o + 1] = hm * k;
  out[o + 2] = hh * k;
  out[o + 3] = hs * k;
}

/** Total height of a row's column (the four parts summed). */
export function totalHeight(inp: RowInput, c: number): number {
  const tmp = new Float32Array(4);
  heightParts(inp, c, tmp, 0);
  return tmp[0] + tmp[1] + tmp[2] + tmp[3];
}

/**
 * Depth of a row of the given age, in world units (negative = away from the camera). Ages outside the window are clamped so a
 * row that is too old or not yet written lies exactly on the far edge.
 */
export function rowZ(age: number): number {
  return -Math.min(Math.max(age, -0.15), WINDOW_S) * UNITS_PER_S;
}

/** 1 in the near land, falling to 0 over the last fifth of the window: the soft horizon, applied to height. */
export function ageFade(age: number): number {
  return 1 - smoothstep(0.78, 1.0, age / WINDOW_S);
}

/**
 * The travelling shockwave of one onset, as a height offset at depth `z` (negative = away) `ta` seconds after the onset.
 * Mirrors the GLSL in shaders.ts. The front starts at the leading edge and moves away at UNITS_PER_S + WAVE_SPEED, faster than
 * the land, so it overtakes the onset's scar and runs ahead of it into the distance, decaying as it goes.
 */
export function shockWave(strength: number, ta: number, z: number): number {
  if (ta < 0 || ta > WAVE_LIFE_S) return 0;
  const front = ta * (UNITS_PER_S + WAVE_SPEED);
  const dz = -z - front;
  const env = Math.exp(-(dz * dz) / (WAVE_WIDTH * WAVE_WIDTH));
  return strength * WAVE_AMP * Math.exp(-ta / (WAVE_LIFE_S * 0.45)) * env * Math.cos(dz * WAVE_K) * (1 - smoothstep(0.7, 1, ta / WAVE_LIFE_S));
}
