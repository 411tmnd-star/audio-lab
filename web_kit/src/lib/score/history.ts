import { clamp01, type AudioFeatureFrame } from "../pipeline/contract";

/**
 * Score's temporal history: a bounded record of what the music did, in order, keyed to the PLAYHEAD clock.
 *
 * What the audio contract does and does not give a consumer (OBSERVED in src/lib/pipeline):
 *  - A frame carries `time`, the playhead position in seconds. It carries no sequence number and no analysis timestamp.
 *  - The pipeline calls `source.sample()` once per animation frame and every call returns a NEW frozen object, even when
 *    nothing was re-analysed. An offline source interpolates between analysis readings (43.07 Hz for the shipped bundles).
 *  - useAudioFrame also re-delivers `pipeline.frame` once when a consumer mounts, so the same object can arrive twice.
 *  - `beatDetected` is true on the single frame an onset fired (adaptive threshold, 120 ms refractory). It is an onset,
 *    not a beat-grid beat.
 *
 * So "one history sample per genuinely new analysis frame" cannot be read from the contract. Score's scene-local rule is:
 * a sample is appended only when the playhead has advanced at least HISTORY_STEP_S since the previous sample, and
 * HISTORY_STEP_S (25 ms) is longer than the offline analysis hop (23.2 ms), so one analysis reading never produces two samples,
 * however many times the browser draws. Samples are stamped with the frame's own `time`, never with a wall clock, so their
 * place on the timeline is exact and pausing, resuming and changing refresh rate cannot move them. The residual limitation
 * (a slow refresh can skip a reading; a live source has no reading grid at all) is recorded in the governing specification.
 *
 * Everything here is allocation-free after construction: fixed typed-array rings, no per-frame objects.
 */

/** Seconds of history kept (the visible window is no longer than this). */
export const HISTORY_WINDOW_S = 12;
/** Minimum playhead advance between samples. Longer than the offline analysis hop 1 / 43.07 = 23.2 ms. */
export const HISTORY_STEP_S = 0.025;
/** Ring capacity: the window at the step, plus slack so the oldest visible sample is never overwritten early. */
export const HISTORY_CAPACITY = Math.ceil(HISTORY_WINDOW_S / HISTORY_STEP_S) + 32;
/** Onset markers kept. The contract's 120 ms refractory allows at most ~8 per second, so 12 s needs 100; 128 is the next power of two. */
export const MARKER_CAPACITY = 128;
/** A forward jump in the playhead larger than this is a seek or a stall: the line is broken there instead of joined. */
export const MAX_JOIN_GAP_S = 0.5;
/** A backward jump larger than this is a rewind or a new source: the record is cleared. */
export const REWIND_EPS_S = 0.05;

/** Counters for tests and diagnostics. */
export interface HistoryStats {
  /** Frames offered. */
  offered: number;
  /** Samples appended. */
  appended: number;
  /** Frames ignored because they were the same object as the previous frame. */
  duplicateFrames: number;
  /** Frames ignored because a value or the time was not finite. */
  invalid: number;
  /** Frames that did not append because the playhead had not advanced a full step (or the source was not playing). */
  skipped: number;
  /** Times the record was cleared (rewind, reset). */
  resets: number;
  /** Line breaks inserted for a forward gap. */
  gaps: number;
  /** Onset markers recorded. */
  onsets: number;
}

export class ScoreHistory {
  /** Sample ring. `t` is the playhead time of the sample, in seconds. `seq` counts samples since the last reset. */
  readonly t = new Float64Array(HISTORY_CAPACITY);
  readonly bass = new Float32Array(HISTORY_CAPACITY);
  readonly mid = new Float32Array(HISTORY_CAPACITY);
  readonly high = new Float32Array(HISTORY_CAPACITY);
  readonly hit = new Float32Array(HISTORY_CAPACITY);
  readonly seq = new Float64Array(HISTORY_CAPACITY);
  /** 1 on a sample that starts a new run (the line is not joined to the sample before it). */
  readonly brk = new Uint8Array(HISTORY_CAPACITY);

  /** Onset-marker ring: playhead time and onset strength (0..1). */
  readonly markT = new Float64Array(MARKER_CAPACITY);
  readonly markS = new Float32Array(MARKER_CAPACITY);

  readonly stats: HistoryStats = { offered: 0, appended: 0, duplicateFrames: 0, invalid: 0, skipped: 0, resets: 0, gaps: 0, onsets: 0 };

  private head = 0; // next write index
  private n = 0; // samples held
  private mHead = 0;
  private mN = 0;
  private lastT = -Infinity;
  private seqNext = 0;
  private lastFrame: AudioFeatureFrame | null = null;
  private beatWasTrue = false;
  /** The playhead time of the most recent valid frame, appended or not: the right-hand edge of the record. */
  private edgeT = 0;

  get count(): number {
    return this.n;
  }

  get markerCount(): number {
    return this.mN;
  }

  /** Playhead time of the newest valid frame seen since the last reset (0 before any). */
  get edgeTime(): number {
    return this.edgeT;
  }

  /** Ring index of the i-th oldest sample (0 = oldest). */
  indexOf(i: number): number {
    return (this.head - this.n + i + HISTORY_CAPACITY * 2) % HISTORY_CAPACITY;
  }

  /** Ring index of the i-th oldest marker. */
  markerIndexOf(i: number): number {
    return (this.mHead - this.mN + i + MARKER_CAPACITY * 2) % MARKER_CAPACITY;
  }

  /** Forget everything: a new source, or a rewind. The next frame starts a new run. Counters other than `resets` are kept. */
  reset(): void {
    this.head = 0;
    this.n = 0;
    this.mHead = 0;
    this.mN = 0;
    this.lastT = -Infinity;
    this.seqNext = 0;
    this.beatWasTrue = false;
    this.edgeT = 0;
    this.lastFrame = null;
    this.stats.resets++;
  }

  /**
   * Offer one frame from the pipeline. Returns true if a sample was appended. Total: never throws and never lets an invalid
   * value into the record.
   */
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

    // Rewind or a new source clock: the old record belongs to a different timeline.
    if (t < this.lastT - REWIND_EPS_S) {
      this.reset();
      this.lastFrame = f;
    }
    this.edgeT = Math.max(this.edgeT, t);

    // Onsets are edge-detected on EVERY valid frame, not only on frames that append a sample: the flag is true for a single
    // frame and can fall between two samples. False -> true records one marker; true -> true records none; true -> false re-arms.
    const beat = f.beatDetected === true;
    if (beat && !this.beatWasTrue && f.isPlaying) this.pushMarker(t, clamp01(f.onsetStrength));
    this.beatWasTrue = beat;

    // A paused or stopped source writes nothing: the playhead is not moving, so there is nothing new to record.
    if (!f.isPlaying) {
      s.skipped++;
      return false;
    }
    if (t - this.lastT < HISTORY_STEP_S - 1e-9) {
      s.skipped++;
      return false;
    }

    const gap = this.lastT > -Infinity && t - this.lastT > MAX_JOIN_GAP_S;
    if (gap) s.gaps++;
    const i = this.head;
    this.t[i] = t;
    this.bass[i] = clamp01(f.bass);
    this.mid[i] = clamp01(f.mid);
    this.high[i] = clamp01(f.high);
    this.hit[i] = clamp01(f.bassHit);
    this.seq[i] = this.seqNext++;
    this.brk[i] = this.n === 0 || gap ? 1 : 0;
    this.head = (this.head + 1) % HISTORY_CAPACITY;
    if (this.n < HISTORY_CAPACITY) this.n++;
    this.lastT = t;
    s.appended++;
    return true;
  }

  private pushMarker(t: number, strength: number): void {
    this.markT[this.mHead] = t;
    this.markS[this.mHead] = strength;
    this.mHead = (this.mHead + 1) % MARKER_CAPACITY;
    if (this.mN < MARKER_CAPACITY) this.mN++;
    this.stats.onsets++;
  }
}
