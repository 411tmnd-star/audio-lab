import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOUNDS, BURST_AMP, BURST_LIFE_S, BURST_SPEED, COUNTS, burstDisplacement, burstOrigin, buildCloud, cameraAt, density, flowAt, macroMask, mulberry32, noise3, potential,
} from "../src/lib/chroma/field";

// The medium: deterministic, bounded, centreless, divergence-free; the burst is a travelling shell.

describe("Chroma field: determinism", () => {
  it("the PRNG and the noise are deterministic and in range", () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 100; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
    assert.equal(noise3(1.3, 2.7, -4.1), noise3(1.3, 2.7, -4.1));
    for (let i = 0; i < 200; i++) { const v = noise3(i * 0.37, i * 0.11, -i * 0.23); assert.ok(v >= 0 && v <= 1); const d = density(i * 0.1 - 6, i * 0.05 - 3, i * 0.07 - 4); assert.ok(d >= 0 && d <= 1); assert.ok(macroMask(i, i * 0.3, -i) >= 0); }
  });
  it("the same seed builds the same cloud, a different seed a different one", () => {
    const a = buildCloud(500, 11, false), b = buildCloud(500, 11, false), c = buildCloud(500, 12, false);
    assert.deepEqual(a.home, b.home);
    assert.deepEqual(a.seed, b.seed);
    assert.notDeepEqual(a.home, c.home);
  });
});

describe("Chroma field: the cloud is a centreless volume of filaments, not an object", () => {
  const dust = buildCloud(COUNTS.full.dust, 0x5eed42, false);
  const ink = buildCloud(COUNTS.full.ink, 0x1c0a11, true);

  it("has the requested counts, all inside the bounds", () => {
    assert.equal(dust.count, COUNTS.full.dust);
    assert.equal(ink.count, COUNTS.full.ink);
    for (const c of [dust, ink]) for (let i = 0; i < c.count; i++) {
      assert.ok(Math.abs(c.home[i * 3]) <= BOUNDS.x && Math.abs(c.home[i * 3 + 1]) <= BOUNDS.y && Math.abs(c.home[i * 3 + 2]) <= BOUNDS.z);
    }
  });

  it("has no central core: the density at the centre is not higher than the average over the volume (radial shells)", () => {
    for (const c of [dust, ink]) {
      const R = Math.hypot(BOUNDS.x, BOUNDS.y, BOUNDS.z);
      const inner = (r: number) => { let n = 0; for (let i = 0; i < c.count; i++) if (Math.hypot(c.home[i * 3] / BOUNDS.x, c.home[i * 3 + 1] / BOUNDS.y, c.home[i * 3 + 2] / BOUNDS.z) < r) n++; return n / c.count; };
      // fraction inside a normalised radius r of a box vs the fraction uniform sampling would give (the ellipsoid volume share)
      const share = (r: number) => (4 / 3) * Math.PI * r ** 3 / 8;
      assert.ok(inner(0.3) < 1.8 * share(0.3), `inner 0.3: ${inner(0.3).toFixed(4)} vs uniform ${share(0.3).toFixed(4)}`);
      assert.ok(inner(0.5) < 1.6 * share(0.5), `inner 0.5: ${inner(0.5).toFixed(4)} vs uniform ${share(0.5).toFixed(4)}`);
      assert.ok(R > 0);
    }
  });

  it("is structured, not uniform haze: occupancy of a coarse grid is strongly uneven (filaments and voids)", () => {
    const N = 8, cells = new Float64Array(N * N * N);
    for (let i = 0; i < dust.count; i++) {
      const ix = Math.min(N - 1, Math.floor(((dust.home[i * 3] / BOUNDS.x + 1) / 2) * N)), iy = Math.min(N - 1, Math.floor(((dust.home[i * 3 + 1] / BOUNDS.y + 1) / 2) * N)), iz = Math.min(N - 1, Math.floor(((dust.home[i * 3 + 2] / BOUNDS.z + 1) / 2) * N));
      cells[(ix * N + iy) * N + iz]++;
    }
    const mean = dust.count / cells.length;
    const sd = Math.sqrt(cells.reduce((s, v) => s + (v - mean) ** 2, 0) / cells.length);
    const noise = 1 / Math.sqrt(mean); // the coefficient of variation uniform sampling gives by chance alone
    assert.ok(sd / mean > 3 * noise, `coefficient of variation ${(sd / mean).toFixed(2)} against ${noise.toFixed(2)} from sampling noise alone`);
    assert.ok(cells.filter((v) => v < 0.25 * mean).length > 0.15 * cells.length, "real voids exist");
  });

  it("registers: dust has three populations in roughly 40/38/22, ink only bass and mid; sizes and randoms in range", () => {
    const count = (c: typeof dust, r: number) => { let n = 0; for (let i = 0; i < c.count; i++) if (c.seed[i * 4 + 2] === r) n++; return n / c.count; };
    assert.ok(Math.abs(count(dust, 0) - 0.4) < 0.03 && Math.abs(count(dust, 1) - 0.38) < 0.03 && Math.abs(count(dust, 2) - 0.22) < 0.03);
    assert.equal(count(ink, 2), 0);
    for (let i = 0; i < dust.count; i++) { const s = dust.seed[i * 4 + 3]; assert.ok(s >= 0.6 && s <= 1.4); assert.ok(dust.seed[i * 4] >= 0 && dust.seed[i * 4] < 1); }
  });
});

describe("Chroma field: the flow is a fluid, not a drift", () => {
  const f: [number, number, number] = [0.3, 1.1, -0.7];
  it("is divergence-free (a curl field): its divergence is near zero everywhere sampled, small against the flow", () => {
    const o: [number, number, number] = [0, 0, 0], a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [0, 0, 0];
    const h = 0.05;
    let maxDiv = 0, maxMag = 0;
    for (let i = 0; i < 300; i++) {
      const x = ((i * 7) % 13) - 6, y = ((i * 5) % 9) - 4, z = ((i * 3) % 11) - 5;
      let div = 0;
      for (let axis = 0; axis < 3; axis++) {
        const p = [x, y, z], q = [x, y, z];
        p[axis] += h; q[axis] -= h;
        flowAt(p[0], p[1], p[2], f, a); flowAt(q[0], q[1], q[2], f, b);
        div += (a[axis] - b[axis]) / (2 * h);
      }
      flowAt(x, y, z, f, o);
      maxDiv = Math.max(maxDiv, Math.abs(div)); maxMag = Math.max(maxMag, Math.hypot(...o));
    }
    assert.ok(maxDiv < 0.02 * maxMag, `max divergence ${maxDiv.toExponential(2)} against flow ${maxMag.toFixed(2)}`);
  });
  it("is finite and bounded, spatially varying (not a uniform drift) and changes smoothly with the phase", () => {
    const o: [number, number, number] = [0, 0, 0], p: [number, number, number] = [0, 0, 0];
    const vs: number[][] = [];
    for (let i = 0; i < 50; i++) { flowAt(i * 0.3 - 7, 0.5, i * 0.2 - 5, f, o); assert.ok(o.every(Number.isFinite) && Math.hypot(...o) < 12); vs.push([...o]); }
    const mean = [0, 1, 2].map((k) => vs.reduce((s, v) => s + v[k], 0) / vs.length);
    const varsum = vs.reduce((s, v) => s + (v[0] - mean[0]) ** 2 + (v[1] - mean[1]) ** 2 + (v[2] - mean[2]) ** 2, 0) / vs.length;
    assert.ok(varsum > 0.5, "the flow differs from place to place");
    flowAt(1, 1, 1, f, o); flowAt(1, 1, 1, [f[0] + 0.01, f[1], f[2]], p);
    assert.ok(Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) < 0.1, "a small phase step is a small change");
  });
  it("the potential matches its own definition (the GLSL mirrors this expression)", () => {
    const o: [number, number, number] = [0, 0, 0];
    potential(0, 0, 0, [0, 0, 0], o);
    assert.deepEqual(o.map((v) => +v.toFixed(6)), [0, 0, 0]);
  });
});

describe("Chroma field: the burst is a shell that travels outward", () => {
  const peakR = (ta: number) => { let br = 0, bv = 0; for (let r = 0; r < 20; r += 0.01) { const v = Math.abs(burstDisplacement(1, ta, r)); if (v > bv) { bv = v; br = r; } } return br; };
  it("is zero before the onset and after its life", () => {
    assert.equal(burstDisplacement(1, -0.1, 1), 0);
    assert.equal(burstDisplacement(1, BURST_LIFE_S + 0.1, BURST_LIFE_S * BURST_SPEED), 0);
  });
  it("its shell moves outward at BURST_SPEED", () => {
    const r1 = peakR(0.3), r2 = peakR(0.9);
    assert.ok(Math.abs((r2 - r1) / 0.6 - BURST_SPEED) < 0.4, `speed ${((r2 - r1) / 0.6).toFixed(2)}`);
  });
  it("decays, scales with strength, never exceeds its amplitude, and pushes outward only", () => {
    const amp = (ta: number) => { let m = 0; for (let r = 0; r < 20; r += 0.02) m = Math.max(m, burstDisplacement(1, ta, r)); return m; };
    assert.ok(amp(0.2) > amp(1.0) && amp(1.0) > amp(1.8));
    assert.ok(amp(0.2) <= BURST_AMP * 1.001);
    assert.ok(Math.abs(burstDisplacement(0.5, 0.5, 2.3) * 2 - burstDisplacement(1, 0.5, 2.3)) < 1e-12);
    for (let r = 0; r < 20; r += 0.1) assert.ok(burstDisplacement(1, 0.7, r) >= 0);
  });
  it("origins are deterministic, inside the bounds and spread (not all in one place)", () => {
    const o: [number, number, number] = [0, 0, 0], seen = new Set<string>();
    for (let n = 0; n < 40; n++) {
      burstOrigin(n, o);
      assert.ok(Math.abs(o[0]) <= BOUNDS.x * 0.7 && Math.abs(o[1]) <= BOUNDS.y * 0.7 && Math.abs(o[2]) <= BOUNDS.z * 0.7);
      seen.add(o.map((v) => v.toFixed(3)).join());
    }
    assert.equal(seen.size, 40);
    const a: [number, number, number] = [0, 0, 0];
    burstOrigin(5, o); burstOrigin(5, a);
    assert.deepEqual(o, a);
  });
});

describe("Chroma field: the camera path", () => {
  it("is a pure, smooth function of the clock that moves slowly and stays outside the volume", () => {
    const p: [number, number, number] = [0, 0, 0], l: [number, number, number] = [0, 0, 0], p2: [number, number, number] = [0, 0, 0];
    let moved = 0;
    for (let t = 0; t < 400; t += 0.5) {
      cameraAt(t, p, l); cameraAt(t, p2, l);
      assert.deepEqual(p, p2);
      assert.ok(p[2] > BOUNDS.z + 3, "outside the volume");
      cameraAt(t + 0.5, p2, l);
      const step = Math.hypot(p2[0] - p[0], p2[1] - p[1], p2[2] - p[2]);
      assert.ok(step < 0.2, `slow: ${step.toFixed(3)} units per half second`);
      moved = Math.max(moved, Math.abs(p[0]));
    }
    assert.ok(moved > 1.5, "it does move");
  });
});
