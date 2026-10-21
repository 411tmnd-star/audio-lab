import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BURST_DECAY_S, FLASH_DECAY_S, FLASH_MIN_INTERVAL_S, MAX_DT_S, createResonatorAnim, stepResonatorAnim } from "../src/lib/resonator/animator";
import { toResonatorParams, type ResonatorParams } from "../src/lib/resonator/params";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

const frame = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, rmsEnergy: 0.6, ...o });
const P = (o: Partial<AudioFeatureFrame> = {}, reduced = false) => toResonatorParams(frame(o), reduced);
const DT = 1 / 60;
const run = (a: ReturnType<typeof createResonatorAnim>, p: ResonatorParams, seconds: number, reduced = false) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) stepResonatorAnim(a, p, DT, reduced);
  return a;
};

describe("Resonator animator: determinism and safety", () => {
  it("the same sequence always gives the same state", () => {
    const seq = [P({ bass: 0.9 }), P({ mid: 0.7, beatDetected: true, onsetStrength: 0.8 }), P({ high: 0.8 }), P()];
    const go = () => {
      const a = createResonatorAnim();
      for (let i = 0; i < 240; i++) stepResonatorAnim(a, seq[i % 4], DT, false);
      return JSON.stringify(a);
    };
    assert.equal(go(), go());
  });

  it("invalid or non-positive steps advance nothing; long steps are shortened to MAX_DT_S", () => {
    const a = createResonatorAnim();
    for (const bad of [0, -1, NaN, Infinity]) stepResonatorAnim(a, P({ bass: 1 }), bad, false);
    assert.equal(a.time, 0);
    stepResonatorAnim(a, P({ bass: 1 }), 5, false);
    assert.equal(a.time, MAX_DT_S);
  });

  it("returns the same object and adds no keys, so a frame allocates nothing", () => {
    const a = createResonatorAnim();
    const keys = Object.keys(a).join();
    assert.equal(stepResonatorAnim(a, P({ bass: 0.5 }), DT, false), a);
    for (let i = 0; i < 100; i++) stepResonatorAnim(a, P({ beatDetected: true, onsetStrength: 1, bassHit: 1 }), DT, false);
    assert.equal(Object.keys(a).join(), keys);
    for (const [k, v] of Object.entries(a)) if (k !== "lastFlashAt") assert.ok(Number.isFinite(v as number), k);
  });
});

describe("Resonator animator: smoothing", () => {
  it("a step input in the bass moves the orb swell gradually, never in one frame", () => {
    const a = createResonatorAnim();
    const p = P({ bass: 1 });
    let prev = 0, maxStep = 0;
    for (let i = 0; i < 120; i++) {
      stepResonatorAnim(a, p, DT, false);
      maxStep = Math.max(maxStep, a.swell - prev);
      prev = a.swell;
    }
    assert.ok(maxStep < 0.25, `largest one-frame rise ${maxStep}`);
    assert.ok(a.swell > 0.95, "and it does arrive");
  });

  it("reduced motion makes the rise slower still", () => {
    const fast = createResonatorAnim(), slow = createResonatorAnim();
    run(fast, P({ mid: 1 }), 0.3, false);
    run(slow, P({ mid: 1 }, true), 0.3, true);
    assert.ok(slow.rise < fast.rise);
  });

  it("phases only grow, and a change of level changes their speed without a jump", () => {
    const a = createResonatorAnim();
    run(a, P({ high: 0.1, mid: 0.1 }), 1);
    const before = { m: a.phaseMid, h: a.phaseHigh, b: a.beadPhase };
    stepResonatorAnim(a, P({ high: 1, mid: 1 }), DT, false);
    assert.ok(a.phaseMid >= before.m && a.phaseHigh >= before.h && a.beadPhase >= before.b);
    assert.ok(a.phaseHigh - before.h < 0.2, "one frame moves the phase a little, not a lot");
  });

  it("highs speed the beads; silence slows them to the rest rate but never freezes the water", () => {
    const loud = createResonatorAnim(), quiet = createResonatorAnim();
    run(loud, P({ high: 1 }), 3);
    run(quiet, P({ high: 0, rmsEnergy: 0 }), 3);
    assert.ok(loud.beadPhase > 3 * quiet.beadPhase, `${loud.beadPhase} vs ${quiet.beadPhase}`);
    assert.ok(quiet.phaseMid > 0, "the water is never frozen in silence");
  });
});

describe("Resonator animator: impulses", () => {
  it("a bass hit kicks the orb and decays", () => {
    const a = createResonatorAnim();
    stepResonatorAnim(a, P({ bassHit: 1 }), DT, false);
    assert.equal(a.kick, 1);
    run(a, P({ bassHit: 0 }), 0.5);
    assert.ok(a.kick < 0.15);
  });

  it("an onset flashes the tracks and bursts the particles; the burst outlasts the flash", () => {
    const a = createResonatorAnim();
    stepResonatorAnim(a, P({ beatDetected: true, onsetStrength: 0.9 }), DT, false);
    assert.equal(a.flash, 0.9);
    assert.equal(a.burst, 0.9);
    assert.equal(a.flashesAccepted, 1);
    run(a, P(), FLASH_DECAY_S * 2);
    assert.ok(a.flash < 0.9 * Math.exp(-1.9));
    assert.ok(a.burst > a.flash * 2, "slower decay for the burst");
    assert.ok(BURST_DECAY_S > FLASH_DECAY_S);
  });

  it("onsets are rate-limited to under 3 per second, whatever the input", () => {
    const a = createResonatorAnim();
    const p = P({ beatDetected: true, onsetStrength: 1 });
    const times: number[] = [];
    let seen = 0;
    for (let i = 0; i < 6 * 60; i++) { // an onset on every frame for 6 seconds
      stepResonatorAnim(a, p, DT, false);
      if (a.flashesAccepted > seen) { seen = a.flashesAccepted; times.push(a.time); }
    }
    assert.ok(seen <= Math.ceil(6 / FLASH_MIN_INTERVAL_S), `accepted ${seen}`);
    for (const t of times) assert.ok(times.filter((x) => x >= t && x < t + 1).length <= 3, `more than 3 flashes in the second from ${t}`);
    assert.ok(a.flashesRejected > 100);
  });

  it("silence and reduced motion never flash", () => {
    const a = createResonatorAnim();
    run(a, toResonatorParams(makeFrame({ ...IDLE_FRAME, beatDetected: true, onsetStrength: 1, bassHit: 1 }), false), 1);
    run(a, P({ beatDetected: true, onsetStrength: 1, bassHit: 1 }, true), 1, true);
    assert.equal(a.flashesAccepted, 0);
    assert.equal(a.flash, 0);
    assert.equal(a.kick, 0);
  });
});
