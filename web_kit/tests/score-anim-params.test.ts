import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_DT_S, SNAP_S, createScoreAnim, stepScoreAnim } from "../src/lib/score/animator";
import { REST_ILLUMINATION, SILENCE_RMS, toScoreParams } from "../src/lib/score/params";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

const frame = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, rmsEnergy: 0.5, ...o });
const DT = 1 / 60;

describe("Score params", () => {
  it("illumination follows rmsEnergy with a floor, and is in 0..1", () => {
    assert.equal(toScoreParams(frame({ rmsEnergy: 0 }), false).illumination, REST_ILLUMINATION);
    assert.ok(toScoreParams(frame({ rmsEnergy: 0.9 }), false).illumination > toScoreParams(frame({ rmsEnergy: 0.2 }), false).illumination);
    for (const v of [0, 0.3, 1]) {
      const p = toScoreParams(frame({ rmsEnergy: v }), false);
      assert.ok(p.illumination >= 0 && p.illumination <= 1);
    }
  });

  it("is pure, tolerant of invalid input, and reads nothing but verified contract fields", () => {
    const f = frame({ rmsEnergy: 0.7 });
    const before = JSON.stringify(f);
    assert.deepEqual(toScoreParams(f, false), toScoreParams(f, false));
    assert.equal(JSON.stringify(f), before);
    const a = toScoreParams(f, false);
    const b = toScoreParams({ ...f, bass: 1, mid: 1, high: 1, subBass: 1, lowMid: 1, rms: 1 } as unknown as AudioFeatureFrame, false);
    assert.deepEqual(a, b, "bands are recorded by the history, not by params; invented fields are ignored");
    assert.ok(Number.isFinite(toScoreParams({ ...f, rmsEnergy: NaN } as AudioFeatureFrame, false).illumination));
  });

  it("flags silence and a stopped source as calm", () => {
    assert.equal(toScoreParams(frame({ rmsEnergy: SILENCE_RMS / 2 }), false).calm, true);
    assert.equal(toScoreParams(frame({ isPlaying: false, rmsEnergy: 0.8 }), false).calm, true);
    assert.equal(toScoreParams(frame({ rmsEnergy: 0.5 }), false).calm, false);
    assert.equal(toScoreParams(frame(), true).reduced, true);
  });
});

describe("Score animator: the displayed clock", () => {
  const play = (a: ReturnType<typeof createScoreAnim>, from: number, seconds: number, rate = 1, dt = DT) => {
    const p = toScoreParams(frame(), false);
    let t = from;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      t += dt * rate;
      stepScoreAnim(a, p, t, dt);
    }
    return t;
  };

  it("follows the playhead while playing, without drift, over a long run", () => {
    const a = createScoreAnim();
    const t = play(a, 0, 600);
    assert.ok(Math.abs(a.now - t) < 0.02, `error ${a.now - t}`);
  });

  it("never runs backwards while playing, even when the source clock is coarse (steps of 50 ms)", () => {
    const a = createScoreAnim();
    const p = toScoreParams(frame(), false);
    let prev = 0;
    for (let i = 0; i < 1200; i++) {
      const t = Math.floor((i * DT) / 0.05) * 0.05; // a stepping currentTime
      stepScoreAnim(a, p, t, DT);
      assert.ok(a.now >= prev - 1e-12, `clock went back at frame ${i}`);
      prev = a.now;
    }
    assert.ok(Math.abs(a.now - 19.95) < 0.1);
  });

  it("holds exactly on the playhead while paused, and resumes from there", () => {
    const a = createScoreAnim();
    const t = play(a, 0, 3);
    const pause = toScoreParams(frame({ isPlaying: false }), false);
    for (let i = 0; i < 300; i++) stepScoreAnim(a, pause, t, DT);
    assert.equal(a.now, t);
    const t2 = play(a, t, 2);
    assert.ok(Math.abs(a.now - t2) < 0.05);
  });

  it("a seek or a new source (a jump larger than SNAP_S) snaps instead of sliding", () => {
    const a = createScoreAnim();
    play(a, 0, 2);
    const p = toScoreParams(frame(), false);
    stepScoreAnim(a, p, 50, DT);
    assert.equal(a.now, 50);
    assert.equal(a.snaps, 1);
    stepScoreAnim(a, p, 50 - SNAP_S - 1, DT);
    assert.equal(a.now, 50 - SNAP_S - 1);
  });

  it("is stable when the browser changes its rendering cadence (30 Hz, 60 Hz, 144 Hz, a 40 ms hitch)", () => {
    for (const dt of [1 / 30, 1 / 60, 1 / 144, 0.04]) {
      const a = createScoreAnim();
      const t = play(a, 0, 20, 1, dt);
      assert.ok(Math.abs(a.now - t) < 0.05, `dt ${dt}: error ${a.now - t}`);
    }
  });

  it("ignores non-finite or negative times and invalid steps, and shortens long steps", () => {
    const a = createScoreAnim();
    const p = toScoreParams(frame(), false);
    stepScoreAnim(a, p, 5, DT);
    const keep = { ...a };
    stepScoreAnim(a, p, NaN, DT);
    stepScoreAnim(a, p, -3, DT);
    stepScoreAnim(a, p, Infinity, DT);
    assert.deepEqual({ ...a }, keep);
    const b = createScoreAnim();
    stepScoreAnim(b, p, 0.1, 5);
    assert.ok(b.now <= 0.1 + 1e-9 && b.now <= MAX_DT_S + 0.1);
  });

  it("returns the same object and adds no keys, so a frame allocates nothing", () => {
    const a = createScoreAnim();
    const keys = Object.keys(a).join();
    const p = toScoreParams(frame(), false);
    for (let i = 0; i < 100; i++) assert.equal(stepScoreAnim(a, p, i * DT, DT), a);
    assert.equal(Object.keys(a).join(), keys);
    for (const v of Object.values(a)) assert.ok(Number.isFinite(v as number));
  });

  it("illumination is smoothed: a step in loudness does not jump in one frame", () => {
    const a = createScoreAnim();
    const p = toScoreParams(frame({ rmsEnergy: 1 }), false);
    stepScoreAnim(a, p, 0, DT);
    assert.ok(a.illumination < 0.3);
    for (let i = 0; i < 120; i++) stepScoreAnim(a, p, i * DT, DT);
    assert.ok(a.illumination > 0.9);
  });
});
