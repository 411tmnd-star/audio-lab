import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COLS, ROWS, STEP_S, UNITS_PER_S, WINDOW_S, rowZ } from "../src/lib/terrain/field";
import { DATA_LENGTH, MAX_JOIN_GAP_S, ONSET_CAPACITY, TEX_W, TerrainHistory } from "../src/lib/terrain/history";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

// Temporal memory of the land, in state-based and numeric assertions. Every call to the helper builds a NEW frozen frame object,
// like the real pipeline does on every animation frame.
const fr = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, bass: 0.2, mid: 0.2, high: 0.2, rmsEnergy: 0.5, ...o });
const CENTRE = Math.floor(COLS / 2);
const times = (h: TerrainHistory) => Array.from({ length: h.count }, (_, i) => h.rowTime(h.count - 1 - i)); // oldest first
const rowCopy = (h: TerrainHistory, r: number) => Float32Array.from({ length: COLS * 4 }, (_, i) => h.part(r, Math.floor(i / 4), i % 4));
/** Plays `seconds` of frames at 60 draws per second starting at `t0`, with the features given by `f(t)`. */
function play(h: TerrainHistory, t0: number, seconds: number, f: (t: number) => Partial<AudioFeatureFrame>) {
  for (let i = 0; i <= Math.round(seconds * 60); i++) {
    const t = t0 + i / 60;
    h.push(fr({ time: t, ...f(t) }));
  }
}
/** Row times are stored as float32 (the shader's texture), so they read back to about 1e-6 s at these playhead times. */
const TOL = 1e-5;
/** Index (0 = newest) of the first row recorded at or after playhead time t. */
const rowFrom = (h: TerrainHistory, t: number) => { let r = -1; for (let i = 0; i < h.count; i++) if (h.rowTime(i) >= t - TOL) r = i; return r; };
const peakBass = (h: TerrainHistory, r: number) => Math.max(...Array.from({ length: COLS }, (_, c) => h.part(r, c, 0)));

describe("Terrain history: a distinct audio event leaves a measurable, durable deformation", () => {
  const EVENT_AT = 2.0;
  const quiet = { bass: 0.05, mid: 0, high: 0 };
  const spike = (t: number) => (t >= EVENT_AT && t < EVENT_AT + 0.2 ? { ...quiet, bass: 0.9 } : quiet);

  it("a bass event raises the land by many times the quiet level, in the middle of the width", () => {
    const h = new TerrainHistory();
    play(h, 0, 2.6, spike);
    const r = rowFrom(h, EVENT_AT);
    assert.ok(r >= 0 && h.rowTime(r) < EVENT_AT + 0.2, "a row exists inside the event");
    const eventPeak = peakBass(h, r);
    const quietPeak = peakBass(h, 0); // the newest row, quiet
    assert.ok(eventPeak > 10 * quietPeak, `event ${eventPeak.toFixed(3)} vs quiet ${quietPeak.toFixed(3)}`);
    // the highest column is near the centre of the width (the central ridge meanders by at most 0.16 of the half width)
    let best = 0;
    for (let c = 0; c < COLS; c++) if (h.part(r, c, 0) > h.part(r, best, 0)) best = c;
    assert.ok(Math.abs(best - CENTRE) < COLS * 0.12, `peak column ${best}`);
  });

  it("the same shape is still there, unchanged, many rows later (the land remembers, nothing is redrawn)", () => {
    const h = new TerrainHistory();
    play(h, 0, 2.5, spike);
    const r = rowFrom(h, EVENT_AT);
    const t = h.rowTime(r);
    const before = rowCopy(h, r);
    assert.ok(Math.max(...Array.from(before)) > 1, "the event row is a tall ridge");
    // five more seconds of different music: loud mids and highs, no bass
    play(h, 2.5 + 1 / 60, 5, () => ({ bass: 0, mid: 0.9, high: 0.9 }));
    // find the same row (same time) now
    let r2 = -1;
    for (let i = 0; i < h.count; i++) if (h.rowTime(i) === t) r2 = i;
    assert.ok(r2 > r + 50, `the row has receded by ${r2 - r} rows`);
    assert.deepEqual(rowCopy(h, r2), before, "the row's heights are bit-for-bit what they were");
  });

  it("the event recedes along Z by UNITS_PER_S per second of the displayed clock", () => {
    const h = new TerrainHistory();
    play(h, 0, 4, spike);
    const r = rowFrom(h, EVENT_AT);
    const t = h.rowTime(r);
    const z = (now: number) => rowZ(now - t);
    const z1 = z(3.0), z2 = z(4.0), z3 = z(5.5);
    assert.ok(Math.abs(z1 - -(3.0 - t) * UNITS_PER_S) < 1e-9, "z = -age * UNITS_PER_S");
    assert.ok(Math.abs(z2 - z1 - -1.0 * UNITS_PER_S) < 1e-9, "one more second is one more UNITS_PER_S away");
    assert.ok(Math.abs(z3 - z2 - -1.5 * UNITS_PER_S) < 1e-9);
    assert.ok(z1 > z2 && z2 > z3, "later means farther (more negative z)");
    // and in rows: index advances by elapsed / STEP
    const rLater = (() => { for (let i = 0; i < h.count; i++) if (h.rowTime(i) === t) return i; return -1; })();
    assert.ok(Math.abs(rLater * STEP_S - (h.edgeTime - t)) < 2 * STEP_S, `row index ${rLater} for ${(h.edgeTime - t).toFixed(2)} s elapsed`);
  });

  it("rows older than the window sit on the far edge, and the window is the ring's full time span", () => {
    assert.ok(Math.abs(rowZ(WINDOW_S + 5) - rowZ(WINDOW_S)) < 1e-12);
    assert.ok(Math.abs(WINDOW_S - (ROWS - 1) * STEP_S) < 1e-12);
  });

  it("an event does not survive past the ring: after one window it is overwritten (bounded memory, not infinite)", () => {
    const h = new TerrainHistory();
    play(h, 0, 2.6, spike);
    play(h, 2.6 + 1 / 60, WINDOW_S + 2, () => quiet);
    for (let i = 0; i < h.count; i++) assert.ok(h.rowTime(i) < EVENT_AT || h.rowTime(i) > EVENT_AT + 0.2 || peakBass(h, i) < 0.5);
  });
});

describe("Terrain history: sampling, repeats, pause and discontinuities", () => {
  it("repeated frames do not create duplicate rows (same object, and many objects at one playhead time)", () => {
    const h = new TerrainHistory();
    const f = fr({ time: 1 });
    for (let i = 0; i < 10; i++) h.push(f);
    assert.equal(h.stats.duplicateFrames, 9);
    for (let i = 0; i < 10; i++) h.push(fr({ time: 1 }));
    assert.equal(h.count, 1);
    assert.equal(h.stats.appended, 1);
  });

  it("at 60 draws per second rows are at least STEP_S apart and strictly ordered, ~20 per second", () => {
    const h = new TerrainHistory();
    play(h, 0, 10, () => ({}));
    const t = times(h);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= STEP_S - TOL && t[i] > t[i - 1]);
    assert.ok(h.stats.appended >= 195 && h.stats.appended <= 202, `${h.stats.appended} rows in 10 s`);
  });

  it("STEP_S is longer than twice the 43.07 Hz offline analysis hop, so one reading cannot yield two rows", () => {
    assert.ok(STEP_S > 2 / 43.07);
  });

  it("pausing records nothing and changes no history state; resuming continues with no gap", () => {
    const h = new TerrainHistory();
    play(h, 0, 3, () => ({}));
    const snap = { count: h.count, head: h.headSlot, writes: h.stats.writes, appended: h.stats.appended, data: Float32Array.from(h.data) };
    for (let i = 0; i < 120; i++) h.push(fr({ time: 3 + i * 0.001, isPlaying: false, bass: 1 }));
    assert.equal(h.count, snap.count);
    assert.equal(h.headSlot, snap.head);
    assert.equal(h.stats.writes, snap.writes);
    assert.equal(h.stats.appended, snap.appended);
    assert.deepEqual(h.data, snap.data, "not one value moved");
    // resume at the time it paused: the next row follows the last with no gap and no void rows
    play(h, 3.02, 1, () => ({}));
    assert.equal(h.stats.gaps, 0);
    assert.equal(h.stats.voidRows, 0);
    assert.ok(h.stats.appended > snap.appended + 15);
  });

  it("a backward seek over 50 ms clears the record (the old rows belong to another timeline)", () => {
    const h = new TerrainHistory();
    play(h, 0, 5, () => ({ bass: 0.9 }));
    assert.ok(h.count > 50);
    h.push(fr({ time: 1.0, bass: 0.1 }));
    assert.equal(h.stats.resets, 1);
    assert.equal(h.count, 1);
    assert.ok(Math.abs(h.rowTime(0) - 1.0) < TOL);
    assert.equal(h.onsetCount, 0);
    assert.ok(peakBass(h, 0) < 0.4, "none of the old loud rows survive");
  });

  it("a small backward jitter (under 50 ms) does not clear anything", () => {
    const h = new TerrainHistory();
    play(h, 0, 2, () => ({}));
    const n = h.count;
    h.push(fr({ time: 2 - 0.02 }));
    assert.equal(h.stats.resets, 0);
    assert.equal(h.count, n);
  });

  it("a forward jump over the join limit is not bridged with invented relief: two flat void rows bracket it", () => {
    const h = new TerrainHistory();
    play(h, 0, 2, () => ({ bass: 0.8 }));
    const lastReal = h.rowTime(0);
    const n = h.stats.appended;
    h.push(fr({ time: lastReal + 20, bass: 0.8 }));
    assert.equal(h.stats.gaps, 1);
    assert.equal(h.stats.voidRows, 2);
    assert.equal(h.stats.appended, n + 1);
    // newest first: the real row, then the void just before it, then the void just after the old edge
    assert.equal(h.rowIsVoid(0), false);
    assert.equal(h.rowIsVoid(1), true);
    assert.equal(h.rowIsVoid(2), true);
    assert.ok(Math.abs(h.rowTime(1) - (lastReal + 20 - STEP_S)) < TOL);
    assert.ok(Math.abs(h.rowTime(2) - (lastReal + STEP_S)) < TOL);
    for (const r of [1, 2]) for (let c = 0; c < COLS; c++) assert.equal(h.height(r, c), 0, "a void row is flat");
    const t = times(h);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], "times stay strictly ordered across the gap");
  });

  it("a jump just under the limit is a normal row", () => {
    const h = new TerrainHistory();
    play(h, 0, 1, () => ({}));
    h.push(fr({ time: h.rowTime(0) + MAX_JOIN_GAP_S - 0.01 }));
    assert.equal(h.stats.gaps, 0);
  });

  it("missing or invalid data is counted and ignored, never recorded", () => {
    const h = new TerrainHistory();
    play(h, 0, 1, () => ({}));
    const w = h.stats.writes;
    const bad = [
      { ...fr({ time: 1.5 }), time: NaN },
      { ...fr({ time: 1.5 }), time: -3 },
      { ...fr({ time: 1.5 }), bass: NaN },
      { ...fr({ time: 1.5 }), mid: Infinity },
      { ...fr({ time: 1.5 }), high: NaN },
    ] as AudioFeatureFrame[];
    for (const b of bad) assert.equal(h.push(b), false);
    assert.equal(h.stats.invalid, bad.length);
    assert.equal(h.stats.writes, w);
    for (let i = 0; i < DATA_LENGTH; i += 97) assert.ok(Number.isFinite(h.data[i]));
  });

  it("an idle frame (nothing loaded) records nothing", () => {
    const h = new TerrainHistory();
    for (let i = 0; i < 50; i++) h.push(makeFrame({ ...IDLE_FRAME, time: i / 60 }));
    assert.equal(h.count, 0);
  });
});

describe("Terrain history: onsets, scars and the shockwave list", () => {
  it("a rising edge records one onset; a held flag records none more; a fall re-arms", () => {
    const h = new TerrainHistory();
    h.push(fr({ time: 1.0, beatDetected: true, onsetStrength: 0.8 }));
    h.push(fr({ time: 1.016, beatDetected: true, onsetStrength: 0.8 }));
    h.push(fr({ time: 1.033, beatDetected: false }));
    h.push(fr({ time: 1.5, beatDetected: true, onsetStrength: 0.6 }));
    assert.equal(h.stats.onsets, 2);
    assert.equal(h.onsetCount, 2);
    assert.equal(h.onsetTime(0), 1.5);
    assert.equal(h.onsetTime(1), 1.0);
    assert.ok(Math.abs(h.onsetStrength(1) - 0.8) < 1e-6);
  });

  it("the onset's scar is deposited in its own row and stays in the land", () => {
    const h = new TerrainHistory();
    play(h, 0, 1, () => ({}));
    h.push(fr({ time: 1.1, beatDetected: true, onsetStrength: 0.9 }));
    play(h, 1.1 + 1 / 60, 2, () => ({}));
    let r = -1;
    for (let i = 0; i < h.count; i++) if (h.rowShock(i) > 0) r = i;
    assert.ok(r > 0);
    assert.ok(Math.abs(h.rowTime(r) - 1.1) < TOL);
    assert.ok(Math.abs(h.rowShock(r) - 0.9) < 1e-6);
    assert.ok(h.part(r, CENTRE, 3) > 0.5, "a crease across the middle");
    for (let i = 0; i < h.count; i++) if (i !== r) assert.equal(h.rowShock(i), 0, "no other row carries it");
  });

  it("an onset whose flag falls on a frame between rows is not lost: it is deposited in the next row", () => {
    const h = new TerrainHistory();
    h.push(fr({ time: 1.0 })); // a row
    h.push(fr({ time: 1.016, beatDetected: true, onsetStrength: 0.7 })); // between rows: no row written
    assert.equal(h.stats.appended, 1);
    assert.equal(h.stats.onsets, 1);
    h.push(fr({ time: 1.05 }));
    assert.ok(Math.abs(h.rowShock(0) - 0.7) < 1e-6);
  });

  it("the strongest of several onsets between two rows is the one deposited, once", () => {
    const h = new TerrainHistory();
    h.push(fr({ time: 1.0 }));
    h.push(fr({ time: 1.01, beatDetected: true, onsetStrength: 0.3 }));
    h.push(fr({ time: 1.02, beatDetected: false }));
    h.push(fr({ time: 1.03, beatDetected: true, onsetStrength: 0.9 }));
    h.push(fr({ time: 1.05 }));
    h.push(fr({ time: 1.1 }));
    assert.ok(Math.abs(h.rowShock(1) - 0.9) < 1e-6);
    assert.equal(h.rowShock(0), 0);
  });

  it("an onset flagged while paused is ignored", () => {
    const h = new TerrainHistory();
    h.push(fr({ time: 1, isPlaying: false, beatDetected: true, onsetStrength: 1 }));
    assert.equal(h.stats.onsets, 0);
  });

  it("onsets waiting for a row before a forward jump are dropped, not deposited after it", () => {
    const h = new TerrainHistory();
    h.push(fr({ time: 1.0 }));
    h.push(fr({ time: 1.01, beatDetected: true, onsetStrength: 0.9 })); // pending, no row yet
    h.push(fr({ time: 30, beatDetected: false })); // a jump
    assert.equal(h.rowShock(0), 0);
  });

  it("the onset list is bounded", () => {
    const h = new TerrainHistory();
    for (let i = 0; i < 500; i++) {
      h.push(fr({ time: i * 0.2, beatDetected: true, onsetStrength: 0.5 }));
      h.push(fr({ time: i * 0.2 + 0.1, beatDetected: false }));
    }
    assert.equal(h.onsetCount, ONSET_CAPACITY);
    assert.equal(h.stats.onsets, 500);
  });
});

describe("Terrain history: bounded, deterministic, independent of loudness", () => {
  it("after 100 000 frames the record is still ROWS rows in one fixed array", () => {
    const h = new TerrainHistory();
    const data = h.data;
    for (let i = 0; i < 100_000; i++) h.push(fr({ time: i / 60, bass: (i % 7) / 7, beatDetected: i % 30 === 0 }));
    assert.equal(h.count, ROWS);
    assert.equal(h.data, data, "the array is never reallocated");
    assert.equal(h.data.length, DATA_LENGTH);
    assert.equal(DATA_LENGTH, TEX_W * ROWS * 4);
    assert.ok(h.stats.appended > 1000);
  });

  it("the same input produces bit-identical history (deterministic)", () => {
    const a = new TerrainHistory(), b = new TerrainHistory();
    const f = (t: number) => ({ bass: 0.5 + 0.4 * Math.sin(t), mid: 0.4, high: 0.3 + 0.2 * Math.cos(3 * t), beatDetected: Math.floor(t * 2) !== Math.floor((t - 1 / 60) * 2), onsetStrength: 0.6 });
    play(a, 0, 20, f);
    play(b, 0, 20, f);
    assert.deepEqual(a.data, b.data);
    assert.deepEqual(a.stats, b.stats);
  });

  it("rmsEnergy never changes the land: loudness lights it, it does not reshape it", () => {
    const a = new TerrainHistory(), b = new TerrainHistory();
    for (let i = 0; i < 600; i++) {
      a.push(fr({ time: i / 60, rmsEnergy: 0 }));
      b.push(fr({ time: i / 60, rmsEnergy: 1 }));
    }
    assert.deepEqual(a.data, b.data);
  });

  it("reset empties the record and clears every row", () => {
    const h = new TerrainHistory();
    play(h, 0, 3, () => ({ bass: 1 }));
    h.reset();
    assert.equal(h.count, 0);
    assert.ok(h.data.every((v) => v === 0));
    assert.equal(h.onsetCount, 0);
  });
});
