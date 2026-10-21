import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BASS_GAIN, COLS, HALF_WIDTH, HIGH_GAIN, MID_GAIN, SCAR_GAIN, UNITS_PER_S, WAVE_AMP, WAVE_LIFE_S, WAVE_SPEED, ageFade, colX, heightParts, rowZ, shockWave, taper, WINDOW_S, type RowInput,
} from "../src/lib/terrain/field";

// The audio grammar of the land: each register has its own shape, and they are measurably different from each other.
const base: RowInput = { t: 3, bass: 0, mid: 0, high: 0, hit: 0, shock: 0 };
function profile(inp: RowInput, k: number): Float32Array {
  const out = new Float32Array(COLS), tmp = new Float32Array(4);
  for (let c = 0; c < COLS; c++) { heightParts(inp, c, tmp, 0); out[c] = tmp[k]; }
  return out;
}
const corr = (a: Float32Array, b: Float32Array) => {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};
/** Local maxima of a profile above 5% of its range: how many separate features it has. */
const peaks = (p: Float32Array) => {
  const hi = Math.max(...p), lo = Math.min(...p);
  let n = 0;
  for (let i = 1; i < p.length - 1; i++) if (p[i] > p[i - 1] && p[i] >= p[i + 1] && p[i] - lo > 0.05 * (hi - lo)) n++;
  return n;
};

describe("Terrain field: each register has its own shape", () => {
  it("bass alone: one broad central ridge, amber part only", () => {
    const p = profile({ ...base, bass: 1 }, 0);
    for (const k of [1, 2, 3]) assert.ok(profile({ ...base, bass: 1 }, k).every((v) => v === 0), `part ${k} stays flat`);
    const top = Math.max(...p);
    assert.ok(top > 0.8 * BASS_GAIN && top < 1.4 * BASS_GAIN, `peak ${top}`);
    let best = 0;
    for (let c = 0; c < COLS; c++) if (p[c] > p[best]) best = c;
    assert.ok(Math.abs(colX(best)) < 0.25, "near the centre");
    const broad = p.filter((v) => v > 0.5 * top).length / COLS; // fraction of the width above half height
    assert.ok(broad > 0.1 && broad < 0.4, `broad: ${broad.toFixed(2)} of the width is above half height`);
    assert.ok(peaks(p) <= 3, `few features (${peaks(p)})`);
  });

  it("mid alone: rolling valleys, zero-mean, both signs, cyan part only", () => {
    const p = profile({ ...base, mid: 1 }, 1);
    for (const k of [0, 2, 3]) assert.ok(profile({ ...base, mid: 1 }, k).every((v) => v === 0));
    assert.ok(Math.max(...p) > 0.3 * MID_GAIN && Math.min(...p) < -0.3 * MID_GAIN, "swells and valleys");
    const mean = p.reduce((s, v) => s + v, 0) / COLS;
    assert.ok(Math.abs(mean) < 0.25 * MID_GAIN, `near zero mean (${mean.toFixed(3)})`);
    assert.ok(peaks(p) >= 2 && peaks(p) <= 6, `intermediate scale (${peaks(p)} swells)`);
  });

  it("high alone: fine micro-crests, many features, never negative, violet part only, much smaller than the bass ridge", () => {
    const p = profile({ ...base, high: 1 }, 2);
    for (const k of [0, 1, 3]) assert.ok(profile({ ...base, high: 1 }, k).every((v) => v === 0));
    assert.ok(Math.min(...p) >= 0);
    assert.ok(peaks(p) >= 12, `fine detail (${peaks(p)} crests)`);
    assert.ok(Math.max(...p) <= HIGH_GAIN * 1.001 && Math.max(...p) > 0.4 * HIGH_GAIN);
    assert.ok(HIGH_GAIN < 0.25 * BASS_GAIN, "micro-crests are a small part of the relief");
  });

  it("the three registers are not redundant: over time their lateral profiles are uncorrelated on average, never identical, and differ in fineness", () => {
    // One instant can overlap by chance (the mid swell can sit on the bass ridge), so correlate across 60 instants.
    const m = (k: number) => (t: number) => profile({ ...base, t, [["bass", "mid", "high"][k]]: 1 } as RowInput, k);
    const series = (a: (t: number) => Float32Array, b: (t: number) => Float32Array) => { const v: number[] = []; for (let i = 0; i < 60; i++) v.push(corr(a(i * 1.7), b(i * 1.7))); return v; };
    for (const [x, y, name] of [[0, 1, "bass~mid"], [0, 2, "bass~high"], [1, 2, "mid~high"]] as const) {
      const v = series(m(x), m(y));
      const mean = v.reduce((s, q) => s + q, 0) / v.length;
      assert.ok(Math.abs(mean) < 0.3, `${name} mean correlation ${mean.toFixed(2)}`);
      assert.ok(Math.max(...v.map(Math.abs)) < 0.95, `${name} is never the same shape`);
    }
    const b = profile({ ...base, bass: 1 }, 0), h = profile({ ...base, high: 1 }, 2);
    assert.ok(peaks(h) > 4 * peaks(b), "high has far finer structure than bass");
  });

  it("silence is flat land", () => {
    for (let k = 0; k < 4; k++) assert.ok(profile(base, k).every((v) => v === 0));
  });

  it("response is linear in level (twice the bass is twice the ridge) and monotonic", () => {
    const a = Math.max(...profile({ ...base, bass: 0.3 }, 0)), b = Math.max(...profile({ ...base, bass: 0.6 }, 0));
    assert.ok(Math.abs(b / a - 2) < 1e-4);
    const hs = [0, 0.25, 0.5, 0.75, 1].map((v) => Math.max(...profile({ ...base, bass: v }, 0)));
    for (let i = 1; i < hs.length; i++) assert.ok(hs[i] > hs[i - 1]);
  });

  it("a bass hit widens and lifts the ridge beyond what the level alone gives", () => {
    const flat = profile({ ...base, bass: 0.5 }, 0), hit = profile({ ...base, bass: 0.5, hit: 1 }, 0);
    assert.ok(Math.max(...hit) > Math.max(...flat) + 0.5);
    assert.ok(hit.filter((v) => v > 0.3).length > flat.filter((v) => v > 0.3).length, "wider");
  });

  it("the scar is a crease across the whole width, only on a row that carries an onset", () => {
    assert.ok(profile(base, 3).every((v) => v === 0));
    const s = profile({ ...base, shock: 1 }, 3);
    assert.ok(s[Math.floor(COLS / 2)] > 0.9 * SCAR_GAIN);
    assert.ok(s.filter((v) => v > 0.4 * SCAR_GAIN).length > 0.6 * COLS, "it spans most of the width");
  });

  it("the land tapers to flat at its lateral borders and stays inside the world width", () => {
    const loud = { ...base, bass: 1, mid: 1, high: 1, hit: 1, shock: 1 };
    const tmp = new Float32Array(4);
    for (const c of [0, COLS - 1]) { heightParts(loud, c, tmp, 0); assert.ok(tmp.every((v) => Math.abs(v) < 1e-6), "flat at the border"); }
    assert.equal(taper(0), 1);
    assert.equal(taper(1), 0);
    assert.ok(HALF_WIDTH > 0);
  });

  it("heights are bounded and finite for any input in range", () => {
    let max = 0;
    for (let t = 0; t < 200; t += 0.37) for (const v of [0, 0.5, 1]) for (let c = 0; c < COLS; c += 3) {
      const tmp = new Float32Array(4);
      heightParts({ t, bass: v, mid: v, high: v, hit: v, shock: v }, c, tmp, 0);
      for (const x of tmp) { assert.ok(Number.isFinite(x)); max = Math.max(max, Math.abs(x)); }
    }
    assert.ok(max < 5, `largest part ${max}`);
  });

  it("is deterministic and depends on time only through the row's own t", () => {
    const a = profile({ ...base, t: 12.5, bass: 0.7, mid: 0.6, high: 0.5 }, 1), b = profile({ ...base, t: 12.5, bass: 0.7, mid: 0.6, high: 0.5 }, 1);
    assert.deepEqual(a, b);
    const c = profile({ ...base, t: 13.5, mid: 0.6 }, 1);
    assert.notDeepEqual(c, profile({ ...base, t: 12.5, mid: 0.6 }, 1));
  });
});

describe("Terrain field: time-to-distance and the shockwave", () => {
  it("depth is linear in age, zero at the leading edge, clamped at the far edge", () => {
    assert.equal(rowZ(0), -0);
    assert.ok(Math.abs(rowZ(1) - -UNITS_PER_S) < 1e-12);
    assert.ok(Math.abs(rowZ(2) / rowZ(1) - 2) < 1e-12);
    assert.equal(rowZ(1e6), rowZ(WINDOW_S));
  });

  it("the soft horizon leaves the near land untouched and brings the far end to zero", () => {
    assert.equal(ageFade(0), 1);
    assert.equal(ageFade(WINDOW_S * 0.5), 1);
    assert.ok(ageFade(WINDOW_S) < 1e-9);
  });

  const front = (ta: number) => {
    let bestZ = 0, best = 0;
    for (let d = 0; d < 40; d += 0.01) { const v = Math.abs(shockWave(1, ta, -d)); if (v > best) { best = v; bestZ = d; } }
    return bestZ;
  };

  it("the wave front travels backward at UNITS_PER_S + WAVE_SPEED and so outruns the land (and the onset's scar)", () => {
    const f1 = front(0.3), f2 = front(0.7);
    assert.ok(Math.abs((f2 - f1) / 0.4 - (UNITS_PER_S + WAVE_SPEED)) < 0.5, `front speed ${((f2 - f1) / 0.4).toFixed(2)}`);
    for (const ta of [0.3, 0.7, 1.1]) assert.ok(front(ta) > ta * UNITS_PER_S + 0.5, "the front is beyond the scar");
  });

  it("the wave decays and ends: zero before the onset and after its life, smaller later", () => {
    assert.equal(shockWave(1, -0.1, -2), 0);
    assert.equal(shockWave(1, WAVE_LIFE_S + 0.1, -10), 0);
    const amp = (ta: number) => { let m = 0; for (let d = 0; d < 40; d += 0.02) m = Math.max(m, Math.abs(shockWave(1, ta, -d))); return m; };
    assert.ok(amp(0.1) > amp(0.9) && amp(0.9) > amp(1.5));
    assert.ok(amp(0.2) <= WAVE_AMP * 1.001);
  });

  it("the wave scales with onset strength and is a ripple (both signs) of modest height", () => {
    let pos = 0, neg = 0;
    for (let d = 0; d < 20; d += 0.02) { const v = shockWave(1, 0.5, -d); pos = Math.max(pos, v); neg = Math.min(neg, v); }
    assert.ok(pos > 0.05 && neg < -0.05);
    assert.ok(Math.abs(shockWave(0.5, 0.5, -3) * 2 - shockWave(1, 0.5, -3)) < 1e-12);
  });
});
