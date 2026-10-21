/**
 * Chroma Field's medium: the pure rules that place the particles and move them. No clock, no DOM, no GPU: everything here is
 * unit-tested in Node. The GLSL in shaders.ts mirrors `potential`, `flowAt` and `burstDisplacement`.
 *
 * The field is a volume of drifting particle density, not a surface: no mesh, no line, no edge. Two populations are drawn as point
 * sprites: a few large, soft INK sprites (the billowing dye of the second reference) and many tiny DUST sprites (the glowing
 * micro-particle filaments of the first). Each particle belongs to a REGISTER (0 bass, 1 mid, 2 high) fixed at creation: that
 * population's visibility and colour band follow its own band, so the registers are separate clouds with their own character.
 * Homes are drawn once, deterministically (seeded PRNG), from a ridged-noise density so that particles gather in filaments and
 * sheets with haze between them; the density has no centre, so there is no core.
 * Motion is the particle's home displaced by a divergence-free (curl) field of a sinusoidal vector potential whose phase is
 * accumulated by the animator (the mid band drives it), so neighbours move together like a fluid and nothing drifts in a flat line.
 * Constants are PROPOSED starting values for visual review.
 */

/** Half-extents of the bounding volume, world units. */
export const BOUNDS = { x: 7.2, y: 3.8, z: 5 } as const;

export type Quality = "full" | "lite";
export const COUNTS: Record<Quality, { ink: number; dust: number }> = { full: { ink: 900, dust: 36000 }, lite: { ink: 350, dust: 14000 } };

/** Shockwave (a volumetric dispersion burst) from one onset. */
export const BURST_SLOTS = 8;
export const BURST_LIFE_S = 2.2;
export const BURST_SPEED = 4.5;
export const BURST_WIDTH = 1.7;
export const BURST_AMP = 1.7;

/** Displacement amplitude of the curl field, world units: a resting amount plus the part the mid band adds. */
export const FLOW_REST = 0.9;
export const FLOW_MID = 2.0;

/** Palette (raw, no colour-space conversion): deep cosmic hues. */
export const PALETTE = {
  indigo: [0.26, 0.22, 1.0],
  teal: [0.0, 0.8, 0.85],
  magenta: [0.86, 0.12, 0.74],
  pink: [1.0, 0.32, 0.6],
} as const;

/** Mulberry32: a small deterministic PRNG, so the same seed always gives the same cloud. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** 3D value noise in 0..1, deterministic. */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

/** A large-scale mask in 0..1 that gathers density into separate masses with real voids between them (none of it is centred). */
export function macroMask(x: number, y: number, z: number): number {
  const k = Math.min(1, Math.max(0, (noise3(x * 0.16 + 31, y * 0.2 + 7, z * 0.16 + 3) - 0.4) / 0.3));
  return k * k * (3 - 2 * k);
}

/** Filament density in 0..1: the product of two ridged noise fields, high only where both are near their ridge (lines and sheets). */
export function density(x: number, y: number, z: number): number {
  const r = (ox: number, oy: number, oz: number) => {
    const n = 0.65 * noise3(x * 0.5 + ox, y * 0.5 + oy, z * 0.5 + oz) + 0.35 * noise3(x * 1.1 + oy, y * 1.1 + oz, z * 1.1 + ox);
    return 1 - Math.abs(2 * n - 1);
  };
  const d = r(11.3, 4.1, 7.7) * r(2.9, 19.2, 5.5);
  return Math.min(1, d * d * d * (0.04 + 2.4 * macroMask(x, y, z)));
}

export interface Cloud {
  /** xyz per particle: the home position. */
  home: Float32Array;
  /** (random a, random b, register 0|1|2, size factor) per particle. */
  seed: Float32Array;
  count: number;
}

/** Builds one population deterministically. `ink` populations carry registers 0 and 1 only. */
export function buildCloud(count: number, seed: number, ink: boolean): Cloud {
  const rnd = mulberry32(seed);
  const home = new Float32Array(count * 3), s = new Float32Array(count * 4);
  let n = 0;
  while (n < count) {
    const x = (rnd() * 2 - 1) * BOUNDS.x, y = (rnd() * 2 - 1) * BOUNDS.y, z = (rnd() * 2 - 1) * BOUNDS.z;
    const haze = rnd() < 0.02;
    // No core: the large-scale mask happened to gather density near the origin (measured at 2.5 times uniform), so the acceptance is
    // lowered towards the centre by a fixed, smooth factor (0.2 at the origin, 1 from about 0.65 of the way out).
    const rn = Math.hypot(x / BOUNDS.x, y / BOUNDS.y, z / BOUNDS.z);
    const rim = 0.2 + 0.8 * Math.min(1, Math.max(0, rn / 0.65)) ** 2;
    const dens = (ink ? 0.04 + 0.96 * macroMask(x, y, z) : density(x, y, z) * 3.2 + 0.01) * rim;
    if (!haze && rnd() > dens) continue;
    home[n * 3] = x; home[n * 3 + 1] = y; home[n * 3 + 2] = z;
    const r = rnd();
    s[n * 4] = rnd();
    s[n * 4 + 1] = rnd();
    s[n * 4 + 2] = ink ? (r < 0.6 ? 0 : 1) : r < 0.4 ? 0 : r < 0.78 ? 1 : 2;
    s[n * 4 + 3] = 0.6 + 0.8 * rnd();
    n++;
  }
  return { home, seed: s, count };
}

/** The vector potential of the flow. `f` is the accumulated flow phase (three numbers, see the animator). Mirrors the GLSL. */
export function potential(x: number, y: number, z: number, f: readonly [number, number, number], out: [number, number, number]): void {
  out[0] = Math.sin(y * 1.31 + f[2] * 0.7) * Math.cos(z * 0.93 + f[0] * 0.5) + 0.5 * Math.sin(y * 2.7 - z * 2.1 + f[1]);
  out[1] = Math.sin(z * 1.17 + f[0] * 0.6) * Math.cos(x * 1.03 + f[1] * 0.4) + 0.5 * Math.sin(z * 2.3 - x * 2.9 + f[2]);
  out[2] = Math.sin(x * 1.23 + f[1] * 0.8) * Math.cos(y * 0.87 + f[2] * 0.3) + 0.5 * Math.sin(x * 2.5 - y * 2.2 + f[0]);
}

/** Finite-difference step of the curl. */
export const CURL_EPS = 0.02;

/** The divergence-free flow (curl of the potential) at a point, by central differences with step CURL_EPS. Mirrors the GLSL. */
export function flowAt(x: number, y: number, z: number, f: readonly [number, number, number], out: [number, number, number]): void {
  const e = CURL_EPS, a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [0, 0, 0];
  const d = (axis: 0 | 1 | 2, comp: 0 | 1 | 2): number => {
    const p = [x, y, z];
    p[axis] += e; potential(p[0], p[1], p[2], f, a);
    p[axis] -= 2 * e; potential(p[0], p[1], p[2], f, b);
    return (a[comp] - b[comp]) / (2 * e);
  };
  out[0] = d(1, 2) - d(2, 1);
  out[1] = d(2, 0) - d(0, 2);
  out[2] = d(0, 1) - d(1, 0);
}

/**
 * A burst's displacement of a particle: a thin spherical shell expanding from the burst origin at BURST_SPEED, pushing particles
 * radially outward, decaying as it goes. `ta` is the age in seconds, `r` the particle's distance from the origin. Returns the
 * outward push in world units (0 before the onset and after BURST_LIFE_S). Mirrors the GLSL.
 */
export function burstDisplacement(strength: number, ta: number, r: number): number {
  if (ta < 0 || ta > BURST_LIFE_S) return 0;
  const dr = r - ta * BURST_SPEED;
  const env = Math.exp(-(dr * dr) / (BURST_WIDTH * BURST_WIDTH));
  const end = 1 - fade(Math.min(1, Math.max(0, (ta / BURST_LIFE_S - 0.6) / 0.4)));
  return strength * BURST_AMP * env * Math.exp(-ta / (BURST_LIFE_S * 0.5)) * end;
}

/** Deterministic burst origin for the n-th onset: a low-discrepancy sequence inside 70% of the bounds. */
export function burstOrigin(n: number, out: [number, number, number]): void {
  const g = (k: number) => 2 * (((n + 1) * k) % 1) - 1;
  out[0] = g(0.6180339887) * BOUNDS.x * 0.7;
  out[1] = g(0.7548776662) * BOUNDS.y * 0.7;
  out[2] = g(0.5698402910) * BOUNDS.z * 0.7;
}

/** The camera path: a slow dolly through the volume, a pure function of the visual clock. */
export function cameraAt(clock: number, pos: [number, number, number], look: [number, number, number]): void {
  pos[0] = 2.2 * Math.sin(0.041 * clock);
  pos[1] = 0.9 * Math.sin(0.029 * clock + 1);
  pos[2] = 12.5 + 1.6 * Math.sin(0.023 * clock);
  look[0] = 0.4 * Math.sin(0.017 * clock);
  look[1] = 0;
  look[2] = 0;
}
