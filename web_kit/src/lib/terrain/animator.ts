import { follow } from "../audio/features";
import type { TerrainParams } from "./params";

/**
 * The stateful layer between the frame and the scene: the displayed clock and the smoothed illumination.
 *
 * The history stamps rows and onsets with the true playhead time of each frame. The scene draws them against `now`, a
 * displayed clock that follows the playhead: it advances by the frame step while playing and is pulled gently towards the
 * playhead, so a coarse source clock (an audio element's currentTime moves in steps) does not make the recession stutter and a
 * refresh-rate change cannot make it drift. Paused, `now` holds the playhead exactly. A jump over SNAP_S snaps. The clock never
 * runs backwards except on a snap. (The same rule as Score's clock, restated here so the scenes stay independent modules.)
 *
 * `stepTerrainAnim` updates one preallocated object in place: a frame allocates nothing. Deterministic: no clock, no DOM, no GPU.
 */

export const MAX_DT_S = 0.05;
export const SNAP_S = 0.25;
export const CORRECTION = 0.1;
export const ATTACK_S = 0.15;
export const RELEASE_S = 0.7;

export interface TerrainAnim {
  /** The displayed clock, seconds on the playhead timeline. */
  now: number;
  /** Smoothed contour and edge intensity, 0..1. */
  illumination: number;
  snaps: number;
}

export function createTerrainAnim(): TerrainAnim {
  return { now: 0, illumination: 0, snaps: 0 };
}

const finite = (x: number) => (Number.isFinite(x) ? x : 0);

/** Advance by `dtS` seconds towards the frame's playhead time `t`. Returns the same object. Invalid input changes nothing. */
export function stepTerrainAnim(a: TerrainAnim, p: TerrainParams, t: number, dtS: number): TerrainAnim {
  if (!Number.isFinite(t) || t < 0) return a;
  const dt = Number.isFinite(dtS) && dtS > 0 ? Math.min(dtS, MAX_DT_S) : 0;

  if (!p.playing) {
    if (Math.abs(a.now - t) > SNAP_S) a.snaps++;
    a.now = t;
  } else if (Math.abs(t - a.now) > SNAP_S) {
    a.now = t;
    a.snaps++;
  } else if (dt > 0) {
    const next = a.now + dt + (t - (a.now + dt)) * CORRECTION;
    a.now = Math.max(a.now, next);
  }

  if (dt > 0) a.illumination = finite(follow(a.illumination, p.illumination, dt, ATTACK_S, RELEASE_S));
  return a;
}
