import { follow } from "../audio/features";
import type { ScoreParams } from "./params";

/**
 * The stateful layer between the frame and the scene: the displayed clock and the smoothed illumination.
 *
 * The history (history.ts) stamps samples and markers with the true playhead time of each frame. The scene draws them against
 * `now`, a displayed clock that follows the playhead: it advances by the frame step while playing and is pulled gently towards
 * the playhead, so a coarse or jittery source clock (an audio element's currentTime moves in steps) does not make the scroll
 * stutter, and a refresh-rate change cannot make it drift. Paused, `now` holds the playhead exactly. A jump of more than
 * SNAP_S (a seek, a new source) snaps. The clock never runs backwards except on a snap.
 *
 * `stepScoreAnim` updates one preallocated object in place: a frame allocates nothing. Deterministic: no clock, no DOM, no GPU.
 */

/** The largest time step taken, so a stalled tab cannot cause a jump. */
export const MAX_DT_S = 0.05;
/** A playhead jump larger than this snaps the displayed clock instead of being smoothed. */
export const SNAP_S = 0.25;
/** Fraction of the clock error corrected per frame while playing. */
export const CORRECTION = 0.1;
/** Illumination envelope times (seconds to about 63%). */
export const ATTACK_S = 0.12;
export const RELEASE_S = 0.6;

export interface ScoreAnim {
  /** The displayed clock, seconds on the playhead timeline. */
  now: number;
  /** Smoothed supporting illumination, 0..1. */
  illumination: number;
  /** 1 while playing, else 0 (smoothed), for the right-hand boundary's intensity. */
  active: number;
  /** Diagnostics: times the clock snapped. */
  snaps: number;
}

export function createScoreAnim(): ScoreAnim {
  return { now: 0, illumination: 0, active: 0, snaps: 0 };
}

const finite = (x: number) => (Number.isFinite(x) ? x : 0);

/**
 * Advance by `dtS` seconds towards the frame's playhead time `t` and the given parameters. Returns the same object.
 * Invalid or non-positive steps and non-finite times change nothing.
 */
export function stepScoreAnim(a: ScoreAnim, p: ScoreParams, t: number, dtS: number): ScoreAnim {
  if (!Number.isFinite(t) || t < 0) return a;
  const dt = Number.isFinite(dtS) && dtS > 0 ? Math.min(dtS, MAX_DT_S) : 0;

  if (!p.playing) {
    // Paused or stopped: hold the playhead exactly (this is also how a new source with time 0 resets the clock).
    if (a.now !== t) a.snaps += Math.abs(a.now - t) > SNAP_S ? 1 : 0;
    a.now = t;
  } else if (Math.abs(t - a.now) > SNAP_S) {
    a.now = t;
    a.snaps++;
  } else if (dt > 0) {
    const next = a.now + dt + (t - (a.now + dt)) * CORRECTION;
    a.now = Math.max(a.now, next);
  }

  if (dt > 0) {
    a.illumination = finite(follow(a.illumination, p.illumination, dt, ATTACK_S, RELEASE_S));
    a.active = finite(follow(a.active, p.playing ? 1 : 0, dt, ATTACK_S, RELEASE_S));
  }
  return a;
}
