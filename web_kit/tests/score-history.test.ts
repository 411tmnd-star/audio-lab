import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HISTORY_CAPACITY, HISTORY_STEP_S, HISTORY_WINDOW_S, MARKER_CAPACITY, MAX_JOIN_GAP_S, ScoreHistory } from "../src/lib/score/history";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

// Every call to the helper builds a NEW frozen frame object, like the real pipeline does on every animation frame.
const fr = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, bass: 0.5, mid: 0.4, high: 0.3, rmsEnergy: 0.5, ...o });
const times = (h: ScoreHistory) => Array.from({ length: h.count }, (_, i) => h.t[h.indexOf(i)]);
const marks = (h: ScoreHistory) => Array.from({ length: h.markerCount }, (_, i) => h.markT[h.markerIndexOf(i)]);

describe("Score history: samples are appended only when the timeline has genuinely advanced", () => {
  it("many frames at the same playhead time make one sample, not one per draw", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 10; i++) h.push(fr({ time: 1.0 }));
    assert.equal(h.count, 1);
    assert.equal(h.stats.appended, 1);
    assert.equal(h.stats.skipped, 9);
  });

  it("the same frame object delivered twice (the mount re-delivery) is ignored", () => {
    const h = new ScoreHistory();
    const f = fr({ time: 2 });
    h.push(f);
    h.push(f);
    assert.equal(h.stats.duplicateFrames, 1);
    assert.equal(h.count, 1);
  });

  it("at 60 draws per second the playhead step limits the record: never more than one sample per step, spacing >= the step", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 600; i++) h.push(fr({ time: i / 60 })); // 10 s
    const t = times(h);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= HISTORY_STEP_S - 1e-9, `spacing ${t[i] - t[i - 1]}`);
    assert.ok(h.count <= Math.floor(10 / HISTORY_STEP_S) + 1);
    assert.ok(h.count > 250, `a 60 Hz draw still records ~30 samples/s, got ${h.count}`);
  });

  it("the step is longer than the offline analysis hop (1/43.07 s), so one reading cannot yield two samples", () => {
    assert.ok(HISTORY_STEP_S > 1 / 43.07);
  });

  it("a faster draw rate (240 Hz) records no more than the step allows", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 2400; i++) h.push(fr({ time: i / 240 }));
    assert.ok(h.count <= Math.floor(10 / HISTORY_STEP_S) + 1);
    assert.ok(h.count >= 10 / HISTORY_STEP_S - 2);
  });

  it("a slow draw (10 Hz) records every frame and fabricates nothing between them", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 20; i++) h.push(fr({ time: i / 10 }));
    assert.equal(h.count, 20);
    assert.equal(h.stats.gaps, 0);
  });
});

describe("Score history: order, bounds and values", () => {
  it("samples are strictly ordered in time and carry the frame's own values", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 100; i++) h.push(fr({ time: i * 0.05, bass: (i % 10) / 10, mid: 0.2, high: 0.9, bassHit: 0.4 }));
    const t = times(h);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
    const k = h.indexOf(7);
    assert.equal(h.t[k], 7 * 0.05);
    assert.ok(Math.abs(h.bass[k] - 0.7) < 1e-6);
    assert.ok(Math.abs(h.mid[k] - 0.2) < 1e-6);
    assert.ok(Math.abs(h.high[k] - 0.9) < 1e-6);
    assert.ok(Math.abs(h.hit[k] - 0.4) < 1e-6);
  });

  it("storage is bounded: after a long session only the newest CAPACITY samples remain, still in order", () => {
    const h = new ScoreHistory();
    const N = HISTORY_CAPACITY * 3;
    for (let i = 0; i < N; i++) h.push(fr({ time: i * 0.03 }));
    assert.equal(h.count, HISTORY_CAPACITY);
    const t = times(h);
    assert.ok(Math.abs(t[t.length - 1] - (N - 1) * 0.03) < 1e-9, "newest kept");
    assert.ok(Math.abs(t[0] - (N - HISTORY_CAPACITY) * 0.03) < 1e-9, "oldest is exactly CAPACITY samples back");
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
    assert.equal(h.t.length, HISTORY_CAPACITY, "the arrays never grow");
  });

  it("the ring covers the visible window", () => {
    assert.ok(HISTORY_CAPACITY * HISTORY_STEP_S >= HISTORY_WINDOW_S);
  });

  it("values are clamped to 0..1 by the frame contract and by the history", () => {
    const h = new ScoreHistory();
    h.push({ ...fr({ time: 1 }), bass: 5, mid: -2, high: 0.5, bassHit: 9 } as AudioFeatureFrame);
    const k = h.indexOf(0);
    assert.equal(h.bass[k], 1);
    assert.equal(h.mid[k], 0);
    assert.equal(h.hit[k], 1);
  });

  it("alternating sequence numbers are kept per sample, and keep their parity as old samples fall off the ring", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < HISTORY_CAPACITY + 50; i++) h.push(fr({ time: i * 0.03 }));
    const s0 = h.seq[h.indexOf(0)];
    assert.equal(s0, 50);
    for (let i = 1; i < h.count; i++) assert.equal(h.seq[h.indexOf(i)] - h.seq[h.indexOf(i - 1)], 1);
  });
});

describe("Score history: pause, resume, gaps, rewinds, source changes", () => {
  it("a paused source records nothing and the record resumes from the same playhead without a break", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 30; i++) h.push(fr({ time: i * 0.03 }));
    const before = h.count;
    for (let i = 0; i < 120; i++) h.push(fr({ time: 0.87, isPlaying: false })); // 2 s of draws while paused
    assert.equal(h.count, before, "nothing written while paused");
    for (let i = 30; i < 60; i++) h.push(fr({ time: i * 0.03 }));
    assert.ok(h.count > before);
    assert.equal(h.stats.gaps, 0, "the playhead did not move during the pause, so there is no gap");
    const t = times(h);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  });

  it("a forward jump bigger than MAX_JOIN_GAP_S breaks the line instead of joining it; a small one is joined", () => {
    const h = new ScoreHistory();
    h.push(fr({ time: 1 }));
    h.push(fr({ time: 1 + MAX_JOIN_GAP_S - 0.05 }));
    assert.equal(h.brk[h.indexOf(1)], 0, "joined");
    h.push(fr({ time: 1 + MAX_JOIN_GAP_S - 0.05 + MAX_JOIN_GAP_S + 0.1 }));
    assert.equal(h.brk[h.indexOf(2)], 1, "broken");
    assert.equal(h.stats.gaps, 1);
    assert.equal(h.brk[h.indexOf(0)], 1, "the first sample always starts a run");
  });

  it("a rewind clears the record: old samples are not mixed into the new timeline", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 100; i++) h.push(fr({ time: 10 + i * 0.03, beatDetected: i % 20 === 0 }));
    assert.ok(h.count > 50 && h.markerCount > 0);
    h.push(fr({ time: 2 }));
    assert.equal(h.stats.resets, 1);
    assert.equal(h.count, 1);
    assert.equal(h.markerCount, 0);
    assert.equal(h.t[h.indexOf(0)], 2);
  });

  it("reset() (a new source) empties the record and re-arms onset detection", () => {
    const h = new ScoreHistory();
    h.push(fr({ time: 1, beatDetected: true }));
    assert.equal(h.markerCount, 1);
    h.reset();
    assert.equal(h.count, 0);
    assert.equal(h.markerCount, 0);
    h.push(fr({ time: 0.5, beatDetected: true }));
    assert.equal(h.markerCount, 1, "an onset asserted on the very first frame of a new source still counts");
  });

  it("the idle frame (no source) records nothing", () => {
    const h = new ScoreHistory();
    for (let i = 0; i < 10; i++) h.push(makeFrame({ ...IDLE_FRAME }));
    assert.equal(h.count, 0);
  });
});

describe("Score history: invalid input", () => {
  it("non-finite or negative times and non-finite bands are rejected and leave the record untouched", () => {
    const h = new ScoreHistory();
    h.push(fr({ time: 1 }));
    const bad = [
      { ...fr({ time: 1.5 }), time: NaN }, { ...fr({ time: 1.5 }), time: Infinity }, { ...fr({ time: 1.5 }), time: -1 },
      { ...fr({ time: 1.5 }), bass: NaN }, { ...fr({ time: 1.5 }), mid: Infinity }, { ...fr({ time: 1.5 }), high: NaN },
    ] as AudioFeatureFrame[];
    for (const b of bad) assert.doesNotThrow(() => h.push(b));
    assert.equal(h.stats.invalid, bad.length);
    assert.equal(h.count, 1);
    for (const arr of [h.t, h.bass, h.mid, h.high, h.hit]) for (let i = 0; i < h.count; i++) assert.ok(Number.isFinite(arr[h.indexOf(i)]));
  });

  it("a bad frame does not disturb onset edge state", () => {
    const h = new ScoreHistory();
    h.push(fr({ time: 1, beatDetected: true }));
    h.push({ ...fr({ time: 1.01, beatDetected: true }), bass: NaN } as AudioFeatureFrame);
    h.push(fr({ time: 1.02, beatDetected: true }));
    assert.equal(h.markerCount, 1);
  });
});

describe("Score history: onsets are edge-triggered", () => {
  const run = (flags: boolean[], dt = 0.016) => {
    const h = new ScoreHistory();
    flags.forEach((b, i) => h.push(fr({ time: i * dt, beatDetected: b, onsetStrength: b ? 0.8 : 0 })));
    return h;
  };

  it("false -> true makes one marker", () => {
    assert.equal(run([false, false, true, false]).markerCount, 1);
  });

  it("true -> true makes no duplicate: a sustained assertion is one onset", () => {
    assert.equal(run([false, true, true, true, true, false]).markerCount, 1);
  });

  it("true -> false re-arms, and false -> true again makes a new marker", () => {
    assert.equal(run([true, false, true]).markerCount, 2);
    assert.equal(run([false, true, true, false, false, true, true, false, true]).markerCount, 3);
  });

  it("an onset on a frame that does not append a sample is still recorded", () => {
    const h = new ScoreHistory();
    h.push(fr({ time: 1.0 }));
    h.push(fr({ time: 1.01, beatDetected: true, onsetStrength: 0.9 })); // 10 ms later: below the step, no sample
    assert.equal(h.count, 1);
    assert.equal(h.markerCount, 1);
    assert.equal(h.markT[h.markerIndexOf(0)], 1.01, "stamped with the frame's own playhead time");
  });

  it("markers carry the strength and share the samples' clock (stamped with the flagged frame's time, in order)", () => {
    const h = new ScoreHistory();
    const flagged: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i / 60;
      const b = i % 30 === 5;
      if (b) flagged.push(t);
      h.push(fr({ time: t, beatDetected: b, onsetStrength: 0.6 }));
    }
    assert.deepEqual(marks(h), flagged);
    assert.ok(Math.abs(h.markS[h.markerIndexOf(0)] - 0.6) < 1e-6);
    // Each marker's time lies within one step of a sample time, so the two share one timeline.
    const t = times(h);
    for (const m of marks(h)) assert.ok(t.some((x) => Math.abs(x - m) < HISTORY_STEP_S + 1e-9));
  });

  it("a paused source does not record onsets", () => {
    const h = new ScoreHistory();
    h.push(fr({ time: 1, isPlaying: false, beatDetected: true }));
    assert.equal(h.markerCount, 0);
  });

  it("the marker ring is bounded and keeps the newest in order", () => {
    const h = run(Array.from({ length: MARKER_CAPACITY * 3 * 2 }, (_, i) => i % 2 === 1), 0.02);
    assert.equal(h.markerCount, MARKER_CAPACITY);
    const m = marks(h);
    for (let i = 1; i < m.length; i++) assert.ok(m[i] > m[i - 1]);
    assert.equal(h.stats.onsets, MARKER_CAPACITY * 3);
  });

  it("the marker ring holds a full window at the contract's fastest rate (one onset per 120 ms refractory)", () => {
    assert.ok(MARKER_CAPACITY >= Math.ceil(HISTORY_WINDOW_S / 0.12));
  });
});
