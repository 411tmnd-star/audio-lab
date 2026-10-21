import { clamp01, type AudioFeatureFrame } from "../pipeline/contract";
import { COLS, ROWS, STEP_S, heightParts, type RowInput } from "./field";

/**
 * Terrain's topographic memory: a bounded ring of heightfield ROWS keyed to the PLAYHEAD clock.
 *
 * Genuine retention, not scrolling: each recorded sample is turned into a lateral cross-section of the land (field.ts) the
 * moment it is recorded, and that row is stored. The land on screen is the stored rows laid out along Z by their own time.
 * Nothing about a row changes after it is written, so a bass swell that happened six seconds ago is still the same shape of
 * ridge now, six seconds farther away. The record is the texture the shader reads: `data` is laid out for it directly.
 *
 * What the audio contract does and does not give (OBSERVED in src/lib/pipeline; see also score/history.ts):
 *  - A frame carries `time` (the playhead) but no sequence number or analysis timestamp, the pipeline hands over a NEW frozen
 *    object every draw, and `useAudioFrame` re-delivers the current frame once on mount.
 *  - `beatDetected` is true on the single frame an onset fired. It is an onset, not a beat grid.
 * So, as in Score (the same constraint, a separate record): a row is appended only when the playhead has advanced at least
 * STEP_S (50 ms, longer than twice the 23.2 ms offline analysis hop, so one reading never yields two rows), rows are stamped
 * with the frame's own time, and nothing is written while the source is not playing. Strict one-row-per-analysis-frame
 * locking would need a sequence number on the shared frame (Class C, not made). The residual limitation: at a display rate
 * whose frame period does not divide 50 ms, row spacing is 50 ms plus up to one frame; rows carry their true times, so the
 * land is geometrically exact either way.
 *
 * Policies (each has a unit test):
 *  - the same frame object offered twice records nothing;
 *  - a frame with a non-finite time or band, or a negative time, is counted and ignored;
 *  - paused/stopped frames record nothing and leave every counter except `skipped` alone;
 *  - a forward jump over MAX_JOIN_GAP_S (a seek, a stall) is NOT bridged with invented relief: two flat "void" rows bracket the
 *    unrecorded span, so the land runs flat across it and the shader can show it as unrecorded;
 *  - a backward jump over REWIND_EPS_S clears the record (the old rows belong to another timeline);
 *  - onsets are edge-detected on every valid playing frame (false to true records one), kept as a bounded list for the
 *    travelling shockwave, and the strongest onset since the last row is deposited into the next row as its scar;
 *  - storage is fixed: `data` is allocated once and rows overwrite the oldest.
 *
 * Allocation-free after construction.
 */

export { COLS, ROWS, STEP_S };
/** Forward jump in the playhead above which the record is not bridged. */
export const MAX_JOIN_GAP_S = 0.5;
/** Backward jump above which the record is cleared. */
export const REWIND_EPS_S = 0.05;
/** Recorded onsets kept for the shockwave (the contract's 120 ms refractory allows ~8 per second). */
export const ONSET_CAPACITY = 32;
/** Texture width: one texel per column plus one metadata texel at the end of the row. */
export const TEX_W = COLS + 1;
/** Floats in the ring: RGBA per texel. */
export const DATA_LENGTH = TEX_W * ROWS * 4;

export interface TerrainStats {
  offered: number;
  /** Real rows recorded. */
  appended: number;
  duplicateFrames: number;
  invalid: number;
  /** Frames that recorded nothing because the source was not playing or the step had not elapsed. */
  skipped: number;
  resets: number;
  /** Forward gaps seen. */
  gaps: number;
  /** Flat void rows written to bracket gaps. */
  voidRows: number;
  /** Onsets recorded. */
  onsets: number;
  /** Every ring write (real and void rows): the scene re-uploads when this changes. */
  writes: number;
}

export class TerrainHistory {
  /**
   * The ring, as the shader's texture: ROWS lines of TEX_W RGBA texels. Texel c < COLS of slot s is (bass, mid, high, scar)
   * height at column c. Texel COLS of slot s is the metadata (t, valid, void, shock). An unwritten slot is all zero.
   */
  readonly data = new Float32Array(DATA_LENGTH);
  /** Recorded onsets: playhead time and strength 0..1, newest last in ring order. */
  readonly onsetT = new Float64Array(ONSET_CAPACITY);
  readonly onsetS = new Float32Array(ONSET_CAPACITY);
  readonly stats: TerrainStats = { offered: 0, appended: 0, duplicateFrames: 0, invalid: 0, skipped: 0, resets: 0, gaps: 0, voidRows: 0, onsets: 0, writes: 0 };

  private head = 0; // next slot to write
  private n = 0;
  private oHead = 0;
  private oN = 0;
  private lastT = -Infinity;
  private lastFrame: AudioFeatureFrame | null = null;
  private beatWasTrue = false;
  private pending = 0;
  private edgeT = 0;
  private readonly scratch: RowInput = { t: 0, bass: 0, mid: 0, high: 0, hit: 0, shock: 0 };

  /** Rows held (real and void), at most ROWS. */
  get count(): number {
    return this.n;
  }

  /** The slot the next row will be written to; the shader reads the newest row at slot head-1. */
  get headSlot(): number {
    return this.head;
  }

  get onsetCount(): number {
    return this.oN;
  }

  /** Playhead time of the newest valid frame since the last reset (0 before any). */
  get edgeTime(): number {
    return this.edgeT;
  }

  /** Slot of the r-th newest row (0 = newest). */
  slotOf(r: number): number {
    return (this.head - 1 - r + ROWS * 2) % ROWS;
  }

  /** Playhead time of the r-th newest row. */
  rowTime(r: number): number {
    return this.data[(this.slotOf(r) * TEX_W + COLS) * 4];
  }

  rowValid(r: number): boolean {
    return r < this.n && this.data[(this.slotOf(r) * TEX_W + COLS) * 4 + 1] > 0.5;
  }

  rowIsVoid(r: number): boolean {
    return this.data[(this.slotOf(r) * TEX_W + COLS) * 4 + 2] > 0.5;
  }

  /** Scar strength deposited in the r-th newest row. */
  rowShock(r: number): number {
    return this.data[(this.slotOf(r) * TEX_W + COLS) * 4 + 3];
  }

  /** Height part `k` (0 bass, 1 mid, 2 high, 3 scar) of column c of the r-th newest row. */
  part(r: number, c: number, k: number): number {
    return this.data[(this.slotOf(r) * TEX_W + c) * 4 + k];
  }

  /** Total height of column c of the r-th newest row. */
  height(r: number, c: number): number {
    const o = (this.slotOf(r) * TEX_W + c) * 4;
    return this.data[o] + this.data[o + 1] + this.data[o + 2] + this.data[o + 3];
  }

  /** The i-th newest recorded onset's time (0 = newest). */
  onsetTime(i: number): number {
    return this.onsetT[(this.oHead - 1 - i + ONSET_CAPACITY * 2) % ONSET_CAPACITY];
  }

  onsetStrength(i: number): number {
    return this.onsetS[(this.oHead - 1 - i + ONSET_CAPACITY * 2) % ONSET_CAPACITY];
  }

  /** Forget everything: a new source, or a rewind. Counters other than `resets` are kept. */
  reset(): void {
    this.data.fill(0);
    this.head = 0;
    this.n = 0;
    this.oHead = 0;
    this.oN = 0;
    this.lastT = -Infinity;
    this.beatWasTrue = false;
    this.pending = 0;
    this.edgeT = 0;
    this.lastFrame = null;
    this.stats.resets++;
    this.stats.writes++;
  }

  /** Offer one frame from the pipeline. Returns true if a real row was recorded. Total: never throws, never records an invalid value. */
  push(f: AudioFeatureFrame): boolean {
    const s = this.stats;
    s.offered++;
    if (f === this.lastFrame) {
      s.duplicateFrames++;
      return false;
    }
    this.lastFrame = f;

    const t = f.time;
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(f.bass) || !Number.isFinite(f.mid) || !Number.isFinite(f.high)) {
      s.invalid++;
      return false;
    }

    if (t < this.lastT - REWIND_EPS_S) {
      this.reset();
      this.lastFrame = f;
    }
    this.edgeT = Math.max(this.edgeT, t);

    // Onsets are edge-detected on every valid frame (the flag lasts one frame and may fall between rows).
    const beat = f.beatDetected === true;
    const rising = beat && !this.beatWasTrue && f.isPlaying === true;
    this.beatWasTrue = beat;
    const strength = clamp01(f.onsetStrength);
    if (rising) {
      this.onsetT[this.oHead] = t;
      this.onsetS[this.oHead] = strength;
      this.oHead = (this.oHead + 1) % ONSET_CAPACITY;
      if (this.oN < ONSET_CAPACITY) this.oN++;
      s.onsets++;
    }

    if (f.isPlaying !== true) {
      s.skipped++;
      if (rising) this.pending = Math.max(this.pending, strength); // cannot happen (rising requires playing); kept for clarity
      return false;
    }

    const advanced = t - this.lastT >= STEP_S - 1e-9;
    if (!advanced) {
      if (rising) this.pending = Math.max(this.pending, strength);
      s.skipped++;
      return false;
    }

    const gap = this.lastT > -Infinity && t - this.lastT > MAX_JOIN_GAP_S;
    if (gap) {
      s.gaps++;
      // The onsets waiting for a row belonged to the timeline before the jump.
      this.pending = 0;
      this.writeVoid(this.lastT + STEP_S);
      this.writeVoid(t - STEP_S);
    }
    if (rising) this.pending = Math.max(this.pending, strength);

    const r = this.scratch;
    r.t = t;
    r.bass = clamp01(f.bass);
    r.mid = clamp01(f.mid);
    r.high = clamp01(f.high);
    r.hit = clamp01(f.bassHit);
    r.shock = this.pending;
    this.pending = 0;
    this.writeRow(r, false);
    this.lastT = t;
    s.appended++;
    return true;
  }

  private writeVoid(t: number): void {
    const r = this.scratch;
    r.t = t;
    r.bass = r.mid = r.high = r.hit = r.shock = 0;
    this.writeRow(r, true);
    this.stats.voidRows++;
  }

  private writeRow(r: RowInput, isVoid: boolean): void {
    const slot = this.head;
    const base = slot * TEX_W * 4;
    for (let c = 0; c < COLS; c++) heightParts(r, c, this.data, base + c * 4);
    const m = base + COLS * 4;
    this.data[m] = r.t;
    this.data[m + 1] = 1;
    this.data[m + 2] = isVoid ? 1 : 0;
    this.data[m + 3] = r.shock;
    this.head = (this.head + 1) % ROWS;
    if (this.n < ROWS) this.n++;
    this.stats.writes++;
  }
}
