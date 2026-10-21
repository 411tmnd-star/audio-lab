import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BURST_LIFE_S, BURST_SLOTS } from "../src/lib/chroma/field";
import { MAX_DT_S, burstAge, createChromaAnim, resetChromaAnim, stepChromaAnim, type ChromaAnim } from "../src/lib/chroma/animator";
import { toChromaParams, type ChromaParams } from "../src/lib/chroma/params";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

const fr = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, bass: 0.4, mid: 0.4, high: 0.4, rmsEnergy: 0.5, ...o });
const P = (o: Partial<AudioFeatureFrame> = {}, reduced = false) => toChromaParams(fr(o), reduced);
const DT = 1 / 60;
const run = (a: ChromaAnim, p: ChromaParams, seconds: number) => { for (let i = 0; i < Math.round(seconds / DT); i++) stepChromaAnim(a, p, DT); return a; };

describe("Chroma params: verified fields only, clamped", () => {
  it("maps the contract fields and nothing else", () => {
    const p = toChromaParams(fr({ bass: 0.2, mid: 0.3, high: 0.4, bassHit: 0.5, rmsEnergy: 0.6, beatDetected: true, onsetStrength: 0.7 }), false);
    assert.deepEqual(p, { bass: 0.2, mid: 0.3, high: 0.4, hit: 0.5, rms: 0.6, onset: true, onsetStrength: 0.7, playing: true, reduced: false });
  });
  it("clamps and survives non-finite values; does not mutate the frame", () => {
    const f = fr();
    const p = toChromaParams({ ...f, bass: NaN, mid: 5, high: -1, rmsEnergy: Infinity } as AudioFeatureFrame, true);
    assert.equal(p.bass, 0); assert.equal(p.mid, 1); assert.equal(p.high, 0); assert.ok(p.rms >= 0 && p.rms <= 1); assert.equal(p.reduced, true);
    assert.ok(Object.isFrozen(f));
  });
});

describe("Chroma animator: envelopes, flow, clock", () => {
  it("each envelope follows its own band and stays in 0..1; silence calms them", () => {
    const a = createChromaAnim();
    run(a, P({ bass: 0.9, mid: 0, high: 0 }), 3);
    assert.ok(a.bass > 0.85 && a.mid < 0.01 && a.high < 0.01);
    run(a, P({ bass: 0, mid: 0.9, high: 0.9 }), 3);
    assert.ok(a.bass < 0.05 && a.mid > 0.85 && a.high > 0.85);
    for (const v of [a.bass, a.mid, a.high, a.hit]) assert.ok(v >= 0 && v <= 1);
  });
  it("the high band is the quickest to respond and the bass the slowest to release", () => {
    const a = createChromaAnim(), b = createChromaAnim();
    run(a, P({ high: 1 }), 0.1); run(b, P({ mid: 1 }), 0.1);
    assert.ok(a.high > b.mid);
    run(a, P({ bass: 1 }), 2); run(a, P({ bass: 0, high: 1 }), 0.25);
    assert.ok(a.bass > 0.3, "bass lingers");
  });
  it("the flow phase advances only while playing, faster with the mid band, and the heading turns (no straight line)", () => {
    const slow = run(createChromaAnim(), P({ mid: 0 }), 6), fast = run(createChromaAnim(), P({ mid: 1 }), 6);
    const dist = (a: ChromaAnim) => Math.hypot(...a.flow);
    assert.ok(dist(fast) > 3 * dist(slow), `${dist(fast).toFixed(2)} vs ${dist(slow).toFixed(2)}`);
    assert.ok(fast.heading > slow.heading);
    const held = createChromaAnim();
    run(held, P({ mid: 1 }), 2);
    const snap = { flow: [...held.flow], clock: held.clock, hue: held.huePhase, shimmer: held.shimmer, heading: held.heading };
    run(held, P({ isPlaying: false, mid: 1 }), 5);
    assert.deepEqual([...held.flow], snap.flow);
    assert.equal(held.clock, snap.clock); assert.equal(held.huePhase, snap.hue); assert.equal(held.shimmer, snap.shimmer); assert.equal(held.heading, snap.heading);
  });
  it("is deterministic and caps the step so a stalled tab cannot jump", () => {
    const a = run(createChromaAnim(), P({ mid: 0.7, beatDetected: false }), 10), b = run(createChromaAnim(), P({ mid: 0.7, beatDetected: false }), 10);
    assert.deepEqual({ ...a, burstT: 0 }, { ...b, burstT: 0 });
    const c = createChromaAnim();
    stepChromaAnim(c, P({ mid: 1 }), 30);
    assert.ok(c.clock <= MAX_DT_S + 1e-12);
    const d = createChromaAnim();
    for (const bad of [NaN, -1, 0, Infinity]) stepChromaAnim(d, P(), bad as number);
    assert.equal(d.clock, 0);
  });
  it("rmsEnergy changes the exposure only, within 0.55..1", () => {
    const quiet = run(createChromaAnim(), P({ rmsEnergy: 0 }), 3), loud = run(createChromaAnim(), P({ rmsEnergy: 1 }), 3);
    assert.ok(Math.abs(quiet.exposure - 0.55) < 0.01 && Math.abs(loud.exposure - 1) < 0.02);
    assert.ok(Math.abs(quiet.bass - loud.bass) < 1e-12 && Math.abs(quiet.flow[0] - loud.flow[0]) < 1e-12);
  });
  it("reduced motion slows the flow to a quarter and leaves the camera and bursts off to the scene", () => {
    const n = run(createChromaAnim(), P({ mid: 0.5 }, false), 6), r = run(createChromaAnim(), P({ mid: 0.5 }, true), 6);
    assert.ok(Math.hypot(...r.flow) < 0.35 * Math.hypot(...n.flow));
  });
});

describe("Chroma animator: onsets are bursts", () => {
  const onset = (a: ChromaAnim, s = 0.8) => { stepChromaAnim(a, P({ beatDetected: true, onsetStrength: s }), DT); stepChromaAnim(a, P({ beatDetected: false }), DT); };
  it("a rising edge records one burst; a held flag records none more; a fall re-arms", () => {
    const a = createChromaAnim();
    stepChromaAnim(a, P({ beatDetected: true, onsetStrength: 0.8 }), DT);
    stepChromaAnim(a, P({ beatDetected: true, onsetStrength: 0.8 }), DT);
    stepChromaAnim(a, P({ beatDetected: true, onsetStrength: 0.8 }), DT);
    assert.equal(a.onsets, 1);
    stepChromaAnim(a, P({ beatDetected: false }), DT);
    stepChromaAnim(a, P({ beatDetected: true, onsetStrength: 0.5 }), DT);
    assert.equal(a.onsets, 2);
    assert.equal(a.bursts, 2);
  });
  it("the same frame delivered twice cannot double an onset", () => {
    const a = createChromaAnim(), p = P({ beatDetected: true, onsetStrength: 1 });
    stepChromaAnim(a, p, DT); stepChromaAnim(a, p, 0);
    assert.equal(a.onsets, 1);
  });
  it("a burst keeps its strength and a deterministic origin, and ages with the visual clock", () => {
    const a = createChromaAnim();
    run(a, P(), 1);
    onset(a, 0.6);
    const k = (a.burstHead - 1 + BURST_SLOTS) % BURST_SLOTS;
    assert.ok(Math.abs(a.burstS[k] - 0.6) < 1e-6);
    assert.ok(Math.abs(burstAge(a, k) - 2 * DT) < 1e-9, "two steps old: the onset step and the step that cleared the flag");
    const b = createChromaAnim();
    run(b, P(), 1); onset(b, 0.6);
    assert.deepEqual(Array.from(a.burstO), Array.from(b.burstO));
    run(a, P(), 1);
    assert.ok(Math.abs(burstAge(a, k) - (1 + 2 * DT)) < 0.02);
    run(a, P(), BURST_LIFE_S + 0.5);
    assert.equal(burstAge(a, k), -1, "expired");
  });
  it("a paused source records no burst and does not age the ones it has", () => {
    const a = createChromaAnim();
    onset(a);
    stepChromaAnim(a, P({ isPlaying: false, beatDetected: true, onsetStrength: 1 }), DT);
    assert.equal(a.onsets, 1);
    const k = (a.burstHead - 1 + BURST_SLOTS) % BURST_SLOTS, age = burstAge(a, k);
    run(a, P({ isPlaying: false }), 3);
    assert.equal(burstAge(a, k), age);
  });
  it("the ring is bounded: many onsets keep BURST_SLOTS slots and count every onset", () => {
    const a = createChromaAnim();
    for (let i = 0; i < 50; i++) { onset(a); run(a, P(), 0.1); }
    assert.equal(a.bursts, BURST_SLOTS);
    assert.equal(a.onsets, 50);
    assert.equal(a.burstT.length, BURST_SLOTS);
  });
  it("a new source forgets onsets and envelopes but keeps the visual clock", () => {
    const a = createChromaAnim();
    run(a, P({ bass: 1 }), 2); onset(a);
    const clock = a.clock;
    resetChromaAnim(a);
    assert.equal(a.bursts, 0); assert.equal(a.onsets, 0); assert.equal(a.bass, 0);
    assert.equal(a.clock, clock);
    assert.equal(a.stats.resets, 1);
    for (let k = 0; k < BURST_SLOTS; k++) assert.equal(burstAge(a, k), -1);
  });
  it("a bass hit compresses briefly: the hit envelope rises fast and falls within about half a second", () => {
    const a = createChromaAnim();
    run(a, P({ bassHit: 1 }), 0.15);
    assert.ok(a.hit > 0.9);
    run(a, P({ bassHit: 0 }), 0.6);
    assert.ok(a.hit < 0.1);
  });
});
