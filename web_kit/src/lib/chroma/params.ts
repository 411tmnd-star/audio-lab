import { clamp01, type AudioFeatureFrame } from "../pipeline/contract";

/**
 * Chroma Field: audio features in, field parameters out. Pure and stateless; the frame is never changed.
 *
 * Fields read, all verified in src/lib/pipeline/contract.ts: isPlaying, bass, mid, high, bassHit, rmsEnergy (the contract's
 * overall-loudness field; named `rmsEnergy`, not `rms`), beatDetected, onsetStrength. `time` is not read: Chroma has no history,
 * its motion runs on its own visual clock (animator.ts). Nothing else exists in the contract: no chroma, pitch, key, harmonic or
 * beat-grid data. Colour is assigned per register (frequency band), never per pitch class.
 */

export interface ChromaParams {
  bass: number;
  mid: number;
  high: number;
  /** Punch of a bass note, 0..1: drives the brief compression. */
  hit: number;
  /** Overall loudness, 0..1: exposure only. */
  rms: number;
  /** True on the single frame an onset fired (an onset, not a beat grid). */
  onset: boolean;
  onsetStrength: number;
  playing: boolean;
  /** Reduced motion: slower flow, a fixed camera, no shimmer and no shockwave. */
  reduced: boolean;
}

export function toChromaParams(f: AudioFeatureFrame, reduced: boolean): ChromaParams {
  return {
    bass: clamp01(f.bass),
    mid: clamp01(f.mid),
    high: clamp01(f.high),
    hit: clamp01(f.bassHit),
    rms: clamp01(f.rmsEnergy),
    onset: f.beatDetected === true,
    onsetStrength: clamp01(f.onsetStrength),
    playing: f.isPlaying === true,
    reduced,
  };
}
