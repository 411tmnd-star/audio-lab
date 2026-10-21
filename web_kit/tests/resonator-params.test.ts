import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CALM_MOTION, REDUCED_MOTION, REST_EXPOSURE, REST_GLOW, SCENE_LEVEL, toResonatorParams, type ResonatorParams } from "../src/lib/resonator/params";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

const frame = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, ...o });
const LOUD = frame({ isPlaying: true, bass: 0.8, mid: 0.6, high: 0.4, rmsEnergy: 0.7, onsetStrength: 0.9, beatDetected: true, bassHit: 0.8, currentSceneState: "active" });
const NUMERIC: Array<keyof ResonatorParams> = ["swell", "glow", "rise", "radial", "ripple", "rippleRate", "beadSpeed", "exposure", "atmosphere", "bloom", "kick", "flash", "burst", "sceneLevel", "motion"];

describe("Resonator params: bounds and purity", () => {
  it("every numeric output is finite and in 0..1 for a spread of frames, normal and reduced", () => {
    for (const reduced of [false, true]) {
      for (const s of ["rest", "build", "active", "settle"] as const) {
        for (const v of [0, 0.03, 0.2, 0.5, 1]) {
          const p = toResonatorParams(frame({ isPlaying: true, bass: v, mid: v, high: v, rmsEnergy: v, onsetStrength: v, beatDetected: v > 0.4, bassHit: v, currentSceneState: s }), reduced);
          for (const k of NUMERIC) assert.ok(Number.isFinite(p[k] as number) && (p[k] as number) >= 0 && (p[k] as number) <= 1, `${k}=${p[k]}`);
        }
      }
    }
  });

  it("is pure: the same frame gives equal results and the frame is not changed", () => {
    const before = JSON.stringify(LOUD);
    assert.deepEqual(toResonatorParams(LOUD, false), toResonatorParams(LOUD, false));
    assert.equal(JSON.stringify(LOUD), before);
    assert.ok(Object.isFrozen(LOUD));
  });

  it("tolerates invalid input without producing NaN", () => {
    const bad = { ...LOUD, bass: NaN, mid: Infinity, high: -3, rmsEnergy: NaN, onsetStrength: 7, bassHit: NaN, currentSceneState: "nonsense" } as unknown as AudioFeatureFrame;
    const p = toResonatorParams(bad, false);
    for (const k of NUMERIC) assert.ok(Number.isFinite(p[k] as number), k);
    assert.equal(p.sceneLevel, SCENE_LEVEL.rest);
  });

  it("reads only fields of the existing frame contract: time, progress and any invented band have no effect", () => {
    const a = toResonatorParams(LOUD, false);
    const b = toResonatorParams({ ...LOUD, time: 99, progress: 0.9, subBass: 1, lowMid: 1 } as unknown as AudioFeatureFrame, false);
    assert.deepEqual(a, b);
  });
});

describe("Resonator params: mapping", () => {
  const steady = (o: Partial<AudioFeatureFrame>) => frame({ isPlaying: true, rmsEnergy: 0.5, ...o });

  it("bass drives the orb swell and plasma glow, with a dim floor for the glow", () => {
    assert.equal(toResonatorParams(steady({ bass: 0.8 }), false).swell, 0.8);
    assert.equal(toResonatorParams(steady({ bass: 0 }), false).glow, REST_GLOW);
    assert.ok(toResonatorParams(steady({ bass: 1 }), false).glow > toResonatorParams(steady({ bass: 0.2 }), false).glow);
  });

  it("mid drives the ribbon rise and the radial modulation, and nothing else changes with it", () => {
    const lo = toResonatorParams(steady({ mid: 0.1 }), false);
    const hi = toResonatorParams(steady({ mid: 0.9 }), false);
    assert.ok(hi.rise > lo.rise && hi.radial > lo.radial);
    assert.equal(hi.swell, lo.swell);
    assert.equal(hi.ripple, lo.ripple);
    assert.equal(hi.beadSpeed, lo.beadSpeed);
  });

  it("high drives the outer ripple and the bead speed, and nothing else changes with it", () => {
    const lo = toResonatorParams(steady({ high: 0.1 }), false);
    const hi = toResonatorParams(steady({ high: 0.9 }), false);
    assert.ok(hi.ripple > lo.ripple && hi.rippleRate > lo.rippleRate && hi.beadSpeed > lo.beadSpeed);
    assert.equal(hi.rise, lo.rise);
    assert.equal(hi.swell, lo.swell);
  });

  it("overall energy drives exposure, atmosphere and bloom, each with a floor", () => {
    const quiet = toResonatorParams(frame({ isPlaying: true, rmsEnergy: 0.05 }), false);
    const loud = toResonatorParams(frame({ isPlaying: true, rmsEnergy: 0.9 }), false);
    assert.ok(loud.exposure > quiet.exposure && loud.atmosphere > quiet.atmosphere && loud.bloom > quiet.bloom);
    assert.ok(quiet.exposure >= REST_EXPOSURE);
  });

  it("an onset (beatDetected) flashes the tracks and bursts the particles, scaled by onset strength; no onset, no flash", () => {
    const on = toResonatorParams(steady({ beatDetected: true, onsetStrength: 0.7 }), false);
    assert.equal(on.flash, 0.7);
    assert.equal(on.burst, 0.7);
    const off = toResonatorParams(steady({ beatDetected: false, onsetStrength: 0.7 }), false);
    assert.equal(off.flash, 0, "onsetStrength alone is a level, not an event");
    assert.equal(off.burst, 0);
  });

  it("bassHit kicks the orb, separately from the smoothed bass level", () => {
    assert.equal(toResonatorParams(steady({ bass: 0.1, bassHit: 0.9 }), false).kick, 0.9);
    assert.equal(toResonatorParams(steady({ bass: 0.9, bassHit: 0 }), false).kick, 0);
  });

  it("scene state sets the scene level", () => {
    for (const s of ["rest", "build", "active", "settle"] as const) assert.equal(toResonatorParams(steady({ currentSceneState: s }), false).sceneLevel, SCENE_LEVEL[s]);
  });
});

describe("Resonator params: silence and reduced motion", () => {
  it("silence and a stopped source remove every impulse and slow the motion", () => {
    for (const f of [IDLE_FRAME, frame({ isPlaying: true, rmsEnergy: 0.01, bassHit: 1, beatDetected: true, onsetStrength: 1 }), frame({ isPlaying: false, rmsEnergy: 0.8, bassHit: 1, beatDetected: true, onsetStrength: 1 })]) {
      const p = toResonatorParams(f, false);
      assert.equal(p.kick, 0);
      assert.equal(p.flash, 0);
      assert.equal(p.burst, 0);
      assert.equal(p.motion, CALM_MOTION);
      assert.equal(p.calm, true);
    }
  });

  it("reduced motion removes impulses and scales motion, but keeps the levels (the picture still follows the music)", () => {
    const p = toResonatorParams(LOUD, true);
    assert.equal(p.kick, 0);
    assert.equal(p.flash, 0);
    assert.equal(p.burst, 0);
    assert.equal(p.motion, REDUCED_MOTION);
    assert.equal(p.swell, 0.8);
    assert.equal(p.rise, 0.6);
    assert.ok(p.ripple < 0.4, "ripple is motion-scaled");
  });
});
