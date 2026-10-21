import { clamp01, type AudioFeatureFrame } from "../pipeline/contract";

/**
 * Terrain: the part of the frame that is NOT part of the land's record. Pure and stateless; the frame is never changed.
 *
 * The land's shape comes from the history (history.ts, field.ts), which stores `bass`, `mid`, `high`, `bassHit` and the
 * onsets (`beatDetected`, `onsetStrength`) per row. What remains is the restrained global intensity from `rmsEnergy` (the
 * contract's overall-loudness field; named `rmsEnergy`, not `rms`): it lights the contour lines and the leading edge and
 * never moves a vertex, so loudness now cannot rewrite the shape of the past.
 *
 * Fields read, all verified in src/lib/pipeline/contract.ts: time, isPlaying, bass, mid, high, bassHit, onsetStrength,
 * beatDetected, rmsEnergy. Nothing else exists in the contract. Constants are PROPOSED starting values.
 */

/** Lighting in silence: the land and its contours stay legible. */
export const REST_ILLUMINATION = 0.4;
/** Overall energy below this counts as silence. */
export const SILENCE_RMS = 0.04;

export interface TerrainParams {
  /** Contour and edge intensity (`rmsEnergy`), 0..1, with a floor. */
  illumination: number;
  /** True when nothing is playing or the signal is near silent. */
  calm: boolean;
  playing: boolean;
  /** Reduced motion: the recession (which is the data) continues, the travelling shockwave is off. */
  reduced: boolean;
}

export function toTerrainParams(f: AudioFeatureFrame, reduced: boolean): TerrainParams {
  const playing = f.isPlaying === true;
  const rms = clamp01(f.rmsEnergy);
  return {
    illumination: clamp01(REST_ILLUMINATION + (1 - REST_ILLUMINATION) * rms),
    calm: !playing || rms < SILENCE_RMS,
    playing,
    reduced,
  };
}
