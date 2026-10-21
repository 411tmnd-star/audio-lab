import { clamp01, type AudioFeatureFrame } from "../pipeline/contract";

/**
 * Score: audio features in, scene parameters out. Pure and stateless; the frame is never changed.
 *
 * Score's three lanes are fed by the temporal history (history.ts), which stores the per-sample values `bass`, `mid`, `high`
 * and `bassHit` straight from the frame. This module covers only what is NOT part of the record: the supporting
 * illumination from `rmsEnergy` (the contract's overall-loudness field, named `rmsEnergy`, not `rms`) and the state flags.
 *
 * Fields used, all verified in src/lib/pipeline/contract.ts: time, isPlaying, bass, mid, high, rmsEnergy, bassHit,
 * onsetStrength, beatDetected. Nothing else is read: no sub-bass, low-mid, beat grid, bar or tempo exists in the contract.
 * Constants are PROPOSED starting values.
 */

/** Lane illumination in silence: the lanes and grid stay legible. */
export const REST_ILLUMINATION = 0.35;
/** Overall energy below this counts as silence. */
export const SILENCE_RMS = 0.04;

export interface ScoreParams {
  /** Supporting illumination of the grid and lane plates (`rmsEnergy`), 0..1, with a floor. Restrained: it never lights a lane itself. */
  illumination: number;
  /** True when nothing is playing or the signal is near silent. */
  calm: boolean;
  /** True when the source is playing. */
  playing: boolean;
  /** Reduced motion: the scroll (which is the data, not decoration) continues, but marker arrival highlights are off. */
  reduced: boolean;
}

export function toScoreParams(f: AudioFeatureFrame, reduced: boolean): ScoreParams {
  const playing = f.isPlaying === true;
  const rms = clamp01(f.rmsEnergy);
  return {
    illumination: clamp01(REST_ILLUMINATION + (1 - REST_ILLUMINATION) * rms),
    calm: !playing || rms < SILENCE_RMS,
    playing,
    reduced,
  };
}
