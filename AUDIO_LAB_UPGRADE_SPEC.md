# AUDIO_LAB_UPGRADE_SPEC (revision 3)

**Status:** PROPOSED. The trade-offs are decided (§13). The M0 operational checklist (Appendix A) awaits explicit approval.
**Revised:** 2026-10-14.
**Scope of this revision:** this file only. No source, configuration, dependency, snapshot or working-copy file has been changed.

## 0. Evidence labels

| Label | Meaning | Required evidence |
|---|---|---|
| **VERIFIED** | Observed directly in this session | Command or file:line, date, result. For tests: command, working directory, exit code and counts. |
| **INFERRED** | Follows from code or documentation, but not executed | The reasoning and the source lines, plus the test that will verify it |
| **PROPOSED** | A design or target that needs your approval | Rationale |
| **UNKNOWN** | Not established. Includes claims from historical reports that were not re-run here. | Where the claim came from, and what would settle it |

Test results from the inspection runs (2026-10-14) were captured only in the session scratchpad. M0 re-runs them and stores raw output durably in the snapshot (Appendix A, steps A15–A18). Until then, cite them as VERIFIED (inspection run, scratchpad).

---

## 1. Objective and non-goals

**Objective.** Make AudioLab's timing and beat information measurably more accurate and its uncertainty honest. Make every Python-to-browser contract explicit, versioned and checked identically in both runtimes. Integrate the Three.js scenes beside the Canvas 2D scenes. Each step is gated by an approved milestone and compared against a verified baseline.

**Three evaluations, never mixed:**

1. **Analysis accuracy:** detected beats, tempo, onsets and regions against annotations (M1, M2).
2. **Confidence calibration:** whether a stated confidence matches observed correctness (M2, deferred until there is enough evidence).
3. **Visual quality:** whether scenes respond legibly and perform well. This is judged by review and by frame-time measurement (M4, M5). It is never used as evidence of analysis accuracy.

**Non-goals for this cycle:**

- Next.js.
- Spectrum Matrix integration.
- A frequency-bin browser contract.
- Automatic meter or downbeat detection that overrides `configs/songs.yaml`.
- Features without a defined purpose and an evaluation (§6).
- Rewriting modules for style.
- Removing Canvas 2D scenes.
- Any break in public JSON compatibility.

---

## 2. Your decisions (captured)

| # | Decision |
|---|---|
| D1 Ground truth | A pilot of **8–12 rights-cleared, annotated tracks** across genres, tempos and rhythmic complexity. The annotation protocol and metrics are defined first (§7). `confidence` stays `null` until there is enough evidence to justify calibration. Candidate tempos are exported, and half/double-tempo errors are tested explicitly. Pilot results are **preliminary evidence, not proof of general accuracy**. |
| D2 Contracts | Versioned, backward-compatible evolution. Evaluate `song_analysis` v1.1 against v1.0 compatibility fixtures. Define units, missing-value behaviour, versioning, numeric tolerances and Python/TypeScript parity (§9). Existing public JSON must not break. |
| D3 Runtime | Keep the esbuild preview harness. Next.js only if repository evidence shows a requirement **and** you approve a separate milestone. |
| D4 Performance | Record the baseline before fixing thresholds. 60 FPS is aspirational and 30 FPS is the provisional floor, on the documented test laptop (§3.1). Measure frame-time distributions, startup cost, bundle size, and WebGL fallback and recovery. |

**Additional requirements (captured):**

- Use the librosa tutorial's feature inventory without duplicating pipelines (§6).
- Validate inputs and numerics (§8).
- Keep accuracy, calibration and visual quality separate (§1).
- Record dependency versions, input hashes, configuration and seeds (§10).
- Preserve the original archives and create a verified rollback snapshot (Appendix A).
- Use the four evidence labels (§0).
- Keep every implementation and dependency change inside an approved milestone.

---

## 3. Verified current state

### 3.1 Environment (VERIFIED, 2026-10-14)

| Item | Value | Evidence |
|---|---|---|
| CPU / GPU / RAM | Intel Core i5-10210U / Intel UHD Graphics (driver 31.0.101.2135) / 15.8 GB | `Get-CimInstance` |
| OS | Windows 11 Pro 10.0.26200 | Environment |
| Browser | Edge 155.0.4283.45 (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) | File version |
| Python | 3.11.0 in `.venv` | `python -c "import sys"` |
| Node / npm | v24.20.0 / 11.19.0 | `node -v`, `npm -v` |
| librosa resampler | `librosa.load` default `res_type='soxr_hq'` | `inspect.signature` |

### 3.2 Repositories and archives (VERIFIED)

- **Live** `C:\Users\USER\Desktop\audio_lab`: not a git repository, no `web_kit/package-lock.json`, and `next` and `three` are not installed. `web_kit/node_modules/.package-lock.json` (npm's hidden lockfile) is present.
- **Working copy** `...\audio_lab_work\2026-10-13_accretion-v0\audio_lab`: not a git repository. It is live plus 77 added WebGL, test and harness paths and a changed `package.json` (`three` 0.186.1, `@types/three` 0.186.0). All other differences are generated files (`preview/dist/squall.*`, `shots/*`). Nothing exists only in live (`diff -rq`).
- **Existing archives** (`C:\Users\USER\Desktop\audio_lab_snapshots\`), which must be preserved unmodified:
  - `2026-10-12_step0_pre-accretion`: README and `MANIFEST.sha256.csv` with columns Path,Sha256,Bytes. The README calls it the compatibility reference.
  - `2026-10-13_pre-accretion-impl`: README, `EXCLUSIONS.txt` and `MANIFEST.sha256.csv` with columns Path,Bytes,Sha256, plus `env/` (hidden lockfile copy, pip dist-info list, `pyvenv.cfg`).
  - `2026-10-13_live-dist-evidence`: `squall.js`, `squall.css` and `HASHES.csv`. Columns: File, Live_Bytes, Live_SHA256, Live_mtime, Snapshot_Bytes, Snapshot_SHA256, Snapshot_mtime. The two files are copies of the **live** dist at that time, so `Live_*` are the values to verify against.
  - No reparse points (junctions or symlinks) under live or `audio_lab_snapshots` (VERIFIED, `Get-ChildItem -Attributes ReparsePoint`). No live path is longer than 200 characters.
  - `C:\Users\USER\Desktop\Python_Toolkit\imports\` also holds copies, with `IMPORT_MANIFEST.csv`.
- **Changes since the last snapshot:** the only live file newer than the 2026-10-13 manifest is this spec (`find -newer`). Bytes are not yet compared (UNKNOWN until A4).
- **Sizes (VERIFIED, 2026-10-14):**

  | Tree | Size |
  |---|---|
  | Live, excluding replaceable trees | 185,153,889 bytes |
  | `web_kit/node_modules` | 73,052,142 bytes |
  | `.venv` | 13,268 files, 524,493,430 bytes |
  | Free on C: | 31,690,764,288 bytes |

  The 2026-10-13 `EXCLUSIONS.txt` recorded `.venv` as 5,433 files and 128,175,232 bytes. Whether this is a change in the venv or a different counting method is UNKNOWN. It is recorded, not interpreted.
- **Editable install.** `.venv/Lib/site-packages/__editable__.audiolab-0.1.0.pth` adds `C:\Users\USER\Desktop\audio_lab\src` to `sys.path` (VERIFIED). Any run against a copy must override this and prove it did (A11).
- **Song durations (VERIFIED, `source.duration_s`):** Seyi 78.0 s, Detty 113.5 s, Jeriq 258.2 s.

### 3.3 Baseline test results (VERIFIED, inspection run, scratchpad)

| Suite | Command (cwd) | Result |
|---|---|---|
| Python | `.venv/Scripts/python.exe -m pytest -q` (live root) | exit 0. **385 passed**, 5 warnings, 109.29 s |
| TypeScript, live | `node_modules/.bin/tsc --noEmit -p tsconfig.json` (`web_kit`) | exit 0, no output |
| Node, live | `node --import ./tests/resolve-ts.mjs --experimental-transform-types --test tests/*.test.ts` (`web_kit`) | exit 0. **99/99**, 24 suites |
| TypeScript, working copy | Same as live | exit 0 |
| Node, working copy | Same as live | exit 0. **263/263**, 69 suites |
| Browser checks | `preview/cdp-check.mjs`, `preview/squall-check.mjs` | **Not run** (UNKNOWN) |
| Next build | — | Not possible (`next` not installed) |

### 3.4 Pipeline facts (VERIFIED from code)

- **Loading.** `io.load_audio` calls `librosa.load(path, sr=22050, mono=True)`. It does no validation and does not record channels, clipping, silence or the resampler. `song_analysis.source` records the original sample rate and channels.
- **Features.**
  - `features.compute_features`: STFT 2048/512; `rms` from S; `rms_db` relative to the song's maximum RMS; centroid in Hz; flatness (ratio); `onset_env`.
  - `band_*_db`: relative to the loudest frame's total power, about ≤ 0 dB (`features.py:35–52`).
  - `mel_db`: 96 bands, 0 dB = loudest cell, `top_db` 80.
  - Silent input is guarded only for the reference value (`np.any`).
- **`analysis.npz`** (Detty): `times`, `rms`, `rms_db`, `centroid`, `flatness`, `onset_env`, `band_{bass,mid,high}_db`, `band_edges_hz`, `mel_db` (96×4887), `mel_freqs`, `beat_times`, `novelty` (per beat), `tempo`, `sample_rate`, `hop_length`, `duration`. Mixed float32 and float64.
- **Curves** in `song_analysis.json` already carry `key`, `grid`, `unit` and `description`.
- **Beats.** `librosa.beat.beat_track(start_bpm=120, tightness=100)`.
  - `clicks.beat_diagnostics` reports `beat_onset_ratio`, `phase_peak_offset` and `tempo_scores` {half, detected, double}. The docstring says half or double above `detected` "is a warning sign".
  - Detty: tempo 112.35 BPM; half 0.484 > detected 0.421 > double 0.392; `tempo.confidence` null.
- **Bars.** `bars.build_bars` takes `beats_per_bar` and `downbeat_offset` from `songs.yaml`, which are human settings. `downbeat_hint` is advisory. Jeriq has no `songs.yaml` entry.
- **Novelty.**
  - Features: MFCC (13, c0 dropped), `chroma_stft`, rms_db and log-centroid, z-scored and beat-synchronised. A Foote checkerboard kernel uses `kernel_beats` 16 (config).
  - `PEAK_HEIGHT = 0.3` and `PEAK_DISTANCE_BEATS = 4` are **module constants, not config** (`novelty.py:86–87`).
- **Events.** `song_analysis.events` have stable ids (`onset:0000`), `source`, and `confidence: null`. The older `events.json` (492 entries for Detty) has no ids.
- **Schema.**
  - `SCHEMA_VERSION = "1.0.0"`. The reader rejects a different major version.
  - `_Model` uses `ConfigDict(extra="forbid")` (`schema.py:33`), so **an added field is rejected by current readers**.
  - The null-confidence rule is written down: "nothing here is a made-up score" (`schema.py:9`).
- **Provenance** records numpy, scipy, librosa, soundfile, pydantic, PyYAML and matplotlib versions. It does **not** record `soxr` (the resampler) or `audioread` (MP3 fallback decoder).
- **Randomness.** Python `src/` and `scripts/` have no RNG use (grep for `np.random|random.|default_rng|seed`: no hits). Browser scenes use hash-derived or seeded values (`instrument/constellation.ts` `hash01`; `squall` `sim.current.rand`). Squall's PRNG seeding is not yet inspected (UNKNOWN).

### 3.5 Browser pipeline facts (VERIFIED from code)

- **Contract.** `AudioFeatureFrame` (`pipeline/contract.ts`): `makeFrame` makes numbers finite (NaN becomes 0), clamps unit fields and freezes the frame. `frameProblems` lists violations. Clamping is silent: no diagnostic is recorded.
- **Feature computation.** Live and offline sources share `FeatureComputer` (`pipeline/computer.ts:50`).
- **Live source.** Main analyser FFT 2048 with smoothing 0.5; low analyser FFT 4096 with smoothing 0. Latency compensation is `baseLatency + outputLatency` (`webaudio.ts:155`).
- **Offline source.** Frame index = `floor(max(0, currentTime − nudge) · rateHz)` (`offline.ts:93–94`). The nudge is clamped to −0.2…+0.4 s.
- **Bundle parsers.** `parseFeaturesMeta` requires `format === "audio-features/1"` and an exact channel list and order. It **ignores unknown keys**. `motion/parse.ts` requires `motion-web/1`.
- **No JSON Schema** exists for `audio-features/1` or `motion-web/1`.
- **Live-vs-offline evidence.**
  - Written by `preview/cdp-check.mjs:221` as `{lagMs, pearson}` only, overwriting `shots/pipe_live_vs_offline.json`.
  - Live copy: lag 100 ms, r = 0.90–0.96. Working copy: lag 50 ms, r = 0.87–0.98.
  - No recording id, duration or sample rate is stored, and Edge runs with `--disable-gpu`.
  - The cause of the lag difference is UNKNOWN.
  - Both original files are preserved as evidence (the live copy in the M0 snapshot; the working copy is never written). M3 investigates with a controlled measurement:
    - a synthetic click track with known impulse times, generated with `tests/synthetic.py`;
    - a fixed `AudioContext` sample rate, recorded alongside `baseLatency` and `outputLatency`;
    - headless and headed runs, with and without `--disable-gpu`, at least 5 repetitions each;
    - lag estimated by cross-correlation and by impulse-onset timing;
    - results appended, never overwritten.
    No cause is assumed beforehand.

### 3.6 WebGL working copy

| Finding | Label |
|---|---|
| `GlHost` owns the renderer and listeners, has no loop of its own, has an idempotent `dispose` (renderer dispose plus `forceContextLoss`), and caps DPR at 1.5 | VERIFIED (code) |
| The `gl-host.test.ts` "ownership" tests (lines 121–150) are regex checks on source text | VERIFIED |
| Unsupported WebGL produces only a text alert (`AccretionCanvas.tsx:142`) | VERIFIED |
| `GlCanvas.tsx` is used only by the `glhost` harness | VERIFIED (grep) |
| Lifecycle, context loss and frame pacing pass in a browser | UNKNOWN (reported in `WEBGL-HOST-REPORT.md` and `ACCRETION-V0-COMPLETION-REPORT.md`: headless Edge 155, simulated loss, 10 s windows) |
| A StrictMode-style remount hands the second host a canvas whose context was force-lost | INFERRED risk. Settled by an M4 test. |
| Spectrum Matrix is a stylised band terrain, not a measured spectrum | VERIFIED (`SPECTRUM-MATRIX-PLAN.md`) |

---

## 4. Data flow and time bases

```
 source file ──sha256──► song_analysis.source / audio-features provenance.audioSha256
   │  t_src = n / sr_src
   ├─► io.load_audio (soxr_hq → 22050 Hz mono)
   │     features (STFT 2048/512, centred) ── frame k ↔ k·512/22050 s
   │     beats ─► bars (+songs.yaml) ─► events / novelty (per beat)
   │     song_analysis.json + analysis.npz ─► interpret ─► visual map (30 Hz) ─► motion plan
   ├─► webfeatures.py (44100 Hz, hop 1024, trailing window) ── frame k ends at k·1024/44100 s
   │                    └── export_web.py ─► audio-features/1, motion-web/1 ◄── motion plan
   │   OfflineSource: k = floor((currentTime − nudge)·rateHz) ┐
   │   RealtimeSource: AnalyserNode at display rate,         ├─► FeatureComputer ─► AudioFeatureFrame
   │                   −(baseLatency+outputLatency)          ┘        (frozen, clamped)
   │                                     one rAF loop (AudioPipeline) ─► useAudioFrame
   │                 Canvas 2D scenes (unchanged)  │  params (pure) ─► animator ─► GlHost.render
   ▼
 render time = rAF timestamp: never an audio time base
```

| Time base | Definition | Label |
|---|---|---|
| Source sample | `n / sr_src` | VERIFIED |
| Analysis frame | `k·512/22050` s, centred STFT | VERIFIED (config, `librosa.frames_to_time`) |
| Beat, event, region | Seconds of source time | VERIFIED |
| Novelty | Per **beat** index, not per frame | VERIFIED (npz shape 207 = beats) |
| Visual mapping | 30 Hz (`--rate` default) | VERIFIED (CLI) |
| Offline web frame | End of a trailing window at `k·1024/44100` s | VERIFIED (docstring) |
| Centred-versus-trailing offset | About 23 ms (2048) and 46 ms (4096) at 44.1 kHz | INFERRED. Confirmed by an M3 test. |
| The two 43.066 Hz rates | Numerically equal, but separate definitions that must not be substituted for each other | VERIFIED value. PROPOSED rule. |

---

## 5. Milestones (overview)

| M | Purpose | Changes the live project? |
|---|---|---|
| **M0** | Archive verification, rollback snapshot, durable baseline, and characterisation of current input behaviour | **No.** New folders only (Appendix A). |
| M1 | Annotation protocol, pilot ground truth, evaluation harness (§7) | Yes: additive `src/audiolab/evaluation/`, `annotations/`, tests |
| M2 | Beat and tempo improvements, tempo candidates, explicit octave-error tests | Yes: `beats.py`, a sidecar export (§9.3) |
| M3 | Contracts: schemas, shared fixtures, Python/TS parity, time-base tests, input validation (§8), live-versus-offline harness | Yes |
| M4a | Three.js integration, Accretion only, smallest boundary (§11) | Yes: `web_kit` and dependencies |
| M5 | Measurement: frame time, startup, bundle, fallback and recovery | Harness scripts and reports |
| M4c | Constellation Core | Yes |

Each milestone needs its own approval. Each starts by naming its exact files and stops on any regression against M0.

---

## 6. Feature inventory: the librosa tutorial against AudioLab

Source: "Audio processing in Python with Feature Extraction for machine learning" (YouTube `vbhlEMcb7RQ`, librosa 0.9.1; transcript supplied 2026-10-14). The rule applied: **no feature is added without a defined purpose and an evaluation that can show it helps.**

| Tutorial item | AudioLab today (VERIFIED) | Decision (PROPOSED) |
|---|---|---|
| `librosa.load`, default `sr` 22050, `sr=None` native, resampling | `io.load_audio` at 22050 mono, `soxr_hq` implicit | Keep. Record `res_type` and the `soxr` and `audioread` versions in provenance. Validate inputs (§8). |
| `waveshow`, `specshow` | `plots.py` overview, bars and interpretation plots | No change |
| STFT plus `amplitude_to_db` | STFT S in `features.py`; dB relative to the song maximum | Keep. Document "relative dB (re: song max)" as the unit; never call it loudness. |
| `beat_track` plus `frames_to_time` | `beats.py`, `clicks.beat_diagnostics` | M1 evaluation, M2 candidates and octave tests |
| `soundfile.write`, 48 kHz rewrite | `clicks.render_click_track` writes WAV | Reuse to generate 48 kHz and 44.1 kHz timing fixtures (M3) |
| Synthetic sine generation | `tests/synthetic.py` | Reuse for all fixtures. No new generator. |
| Zero-crossing rate | Not computed | **Not added.** Possible purpose: percussive-versus-tonal cue for onset or region labelling, but it overlaps `flatness`. Reconsider only if an M2 or region evaluation shows a gain. |
| Spectral centroid | Computed (Hz, float64), in npz, used in novelty (log) | Keep. The tutorial's min-max normalisation stays in `visual_mapping`, never in analysis artifacts. |
| Spectral rolloff | Not computed | **Not added.** Overlaps centroid, no defined consumer. |
| MFCC (20 in tutorial; feature scaling) | 13 MFCC, c0 dropped, z-scored per row, novelty only, **not stored** | Keep internal. Optionally store the beat-synchronised matrix only if region evaluation needs reproducible inputs (§14). |
| Chroma STFT (12×frames, hop 512) | Novelty only, not stored | Same as MFCC |
| RMS from `y` or from S via `magphase` | From S (`frame_length=n_fft`) | Keep. Document that RMS-from-S and RMS-from-y differ slightly (padding and windowing); tests compare like with like. |
| sklearn scaling | Not used | No new dependency |

Guidance-document items that are accepted:

- Expose the novelty peak parameters as config and provenance (M3, additive).
- Keep novelty peaks distinct from section boundaries.
- Make the exporter the compatibility boundary.
- Record a diagnostic when clamping hides a fault.

The following were **not verified** in the guidance text and are not used as facts: "Accretion contains disk, photon ring, jets, stars"; "Constellation Core has eight orbs"; feature flags. The guidance text was truncated at §5.3.

---

## 7. Ground truth and evaluation (M1, M2)

### 7.1 Pilot corpus (PROPOSED)

- **8–12 rights-cleared tracks.**
- **Coverage:**
  - at least 3 tempo bands (< 90, 90–130, > 130 BPM);
  - at least 4 genres;
  - at least 2 tracks with syncopation or swing, or with a weak kick;
  - at least 1 track with a tempo change or rubato;
  - at least 1 live or non-studio recording.
- The three current songs may be included if rights allow.
- **Audio stays outside the repository.** It is referenced by sha256 in `annotations/manifest.yaml`, which records id, local path, sha256, genre, tempo band, complexity tags, recording condition, rights statement, annotator and method.

### 7.2 Annotation protocol (PROPOSED)

- **Format.** `annotations/<id>.beats.tsv` with columns `time_s` (source-file seconds, 3 decimals) and `beat_position` (1 = downbeat, integer, optional). The header comment carries the source sha256, annotator, tool and date.
- **Method:**
  1. Tap along twice, in Sonic Visualiser or an equivalent tool.
  2. Correct on the waveform.
  3. Verify by ear using a click render (`clicks.render_click_track`).
- **Ambiguity.** The annotated metrical level is the one the annotator taps naturally. When half or double is equally plausible, the alternative is recorded with `alt_level: half|double` in the manifest; the alternative is never an equal-weight truth.
- **Quality control.** Re-annotate 2 tracks after at least one day to measure intra-annotator agreement (F-measure between the two passes). A second annotator is optional (§13).
- **Validation.** An annotation file whose sha256 does not match the audio is rejected. Times must be sorted, within the duration, and non-finite values are rejected.

### 7.3 Metrics (PROPOSED)

| Metric | Measures |
|---|---|
| F-measure ±70 ms | Beat placement |
| CMLt / AMLt | Continuity; AMLt tolerates octave and offbeat errors |
| **CMLt − AMLt gap** and **octave class** per track (correct / half / double / ⅓ / other) | **The explicit half/double-tempo test** |
| Tempo Acc1 (±4 %) and Acc2 (±4 % at ×½, ×2, ×⅓, ×3) | Tempo |
| Downbeat F-measure (±70 ms) | `downbeat_hint` only. Human overrides are never scored as detections. |
| Novelty-peak precision and recall at ±1 beat and ±2 s | Only if regions are annotated (optional, §14) |

**Reporting:** per-track tables plus means, broken down by tempo band and complexity tag, and paired comparison against the M1 baseline. No significance claims are made from the pilot (D1).

### 7.4 Candidates and confidence (M2)

- Export ranked **tempo candidates** (BPM and the existing `tempo_scores`, plus tempogram peaks) and an `octave_ambiguity` flag when half or double scores at least as high as detected. Both are measurements, not probabilities.
- `Tempo.confidence` **stays null** for the pilot.
- Calibration is reconsidered only when **the corpus reaches ≥ 30 tracks with held-out evaluation** (PROPOSED threshold). Calibration is then judged by reliability curve and expected calibration error.

---

## 8. Input and numeric validation (M3; current behaviour characterised in M0)

**Decided (§13):** reject corrupt, empty and non-finite input. Warn on silence, clipping and low sample rate according to explicit thresholds. Record every warning, rejection, clamp and correction. Never conceal invalid data.

| Check | Current behaviour | Rule | Severity | Threshold (PROPOSED, config key) |
|---|---|---|---|---|
| Unreadable or corrupt file, decode error, wrong content | UNKNOWN (librosa raises, unwrapped). Characterised in A12. | Reject | reject | Any decode exception |
| Empty | UNKNOWN | Reject | reject | 0 bytes, or 0 decoded samples |
| Non-finite samples | Not checked | Reject | reject | Any NaN or ±Inf in decoded samples, checked before resampling |
| Non-finite features | Not checked | Treated as an internal fault: abort before writing | reject | Any NaN or ±Inf in arrays to be saved, except documented floors (below) |
| Silence | Reference guarded; downstream UNKNOWN | Accept and warn. Outputs must stay finite; beats may be empty. | warn | `input.silence_peak_dbfs: -60` (peak below −60 dBFS) |
| Clipping | Not detected | Accept and warn. Counts are computed per channel, before downmix and resampling. Samples with \|x\| > 1.0 (possible in decoded MP3) are counted separately. | warn | `input.clip_level: 0.999` full scale; warn when the fraction exceeds `input.clip_warn_fraction: 0.001` |
| Low sample rate | Original recorded, silently upsampled | Accept and warn | warn | `input.low_sr_hz: 22050` (original below the analysis rate) |
| Channel cancellation | Not detected | Accept and warn | warn | Mono RMS below the mean channel RMS by more than `input.cancel_db: 12` |
| Resampling and downmix | Implicit | Record `res_type`, original and analysis rates, and downmix method | info | — |
| Units | Curves carry `unit`; dB references implicit | Every curve states its unit and reference ("dB re song max", "Hz", "ratio") | — | — |
| Frame alignment | Docstring only | Tests at t = 0, a mid-file time and the last frame, for 22050/512, 44100/1024 and 48000/1024 | — | — |
| Normalisation | Per-song relative dB; 0..1 only in browser and visual mapping | Analysis artifacts never contain min-max-normalised features | — | — |

**Documented floors.** These are not corrections, but they must be listed in feature definitions: `band_*_db` adds 1e-10 before the log (`features.py:49`), and `mel_db` uses `top_db=80`.

**How every outcome is recorded (PROPOSED):**

- **Accepted input.** The sidecar (§9.1) section `input_report` lists every check: `code`, `severity` (info / warn), measured value, threshold, config key and, where relevant, a channel or time location.
- **Rejected input.**
  - `analyze` exits non-zero and writes no song artifacts.
  - It prints a structured message naming the file, check, value and threshold.
  - It appends one JSON line to `<out>/_input_rejections.jsonl`, with source path, sha256 if readable, check, value, threshold, audiolab version and time.
- **Python corrections** (any replaced or clamped value) are listed in `input_report.corrections` with counts. None exist today apart from the floors above.
- **Browser clamping.**
  - `makeFrame` keeps its fallback (non-finite becomes 0, unit fields clamped), so the frame contract does not change.
  - The pipeline keeps per-field counters `{nonFinite, belowZero, aboveOne}`, readable through a diagnostics accessor and asserted in tests.
  - Counters are never written into frames.

All thresholds are PROPOSED and are confirmed or revised against the A12 characterisation before M3 implements them.

---

## 9. Contracts (M3)

### 9.1 Versioning and compatibility

- **The public `song_analysis` contract stays 1.0.0 and unchanged.** No field is added, removed or reinterpreted in this cycle. Fixtures: the three current files, frozen in M0.
- **v1.1 is evaluated, not adopted.** M3 writes v1.1 *candidate* fixtures to measure the impact: a v1.0 reader rejects them because of `extra="forbid"`. Adoption needs a separate, approved migration.
- **Experimental fields go in a separately versioned sidecar (decided).** The sidecar is introduced only after this subsection is approved, in M2 or M3:

| Item | Specification (PROPOSED) |
|---|---|
| File | `<song>/analysis_extras.json`, written by the same `analyze` run, next to `song_analysis.json` |
| Identity | `schema_name: "audiolab.analysis_extras"`, `schema_version: "0.1.0"`. The 0.x major means **experimental**: a minor bump may break, and each version has its own schema file (`schemas/analysis_extras.v0.1.json`) and fixtures. |
| Binding to the analysis | `subject`: `song_analysis_file` (relative name), `song_analysis_schema_version`, `song_analysis_sha256` (sha256 of the exact JSON bytes written in the same run), `source_sha256` (must equal `song_analysis.source.sha256`) |
| Provenance | `created_at`, audiolab version, producer module and function, Python and library versions **including `soxr` and `audioread`**, `res_type`, the effective config and its sha256 |
| Time base | Same convention as `song_analysis.time_base` (seconds of source time; sample rate; hop) |
| Contents in 0.1 | `tempo_candidates[]` {`bpm`, `rank`, `source` (`beat_track`/`tempogram`), `score`, `score_kind`}; `octave` {`scores` {half, detected, double}, `ambiguous` (bool), `rule`}; `input_report` (§8). Every `confidence` is `null` (D1). |
| Model strictness | Pydantic `extra="forbid"`, dispatching on `schema_version` |
| Compatibility rules | (1) `song_analysis.json` never references the sidecar, so 1.0 readers are untouched. (2) The sidecar is optional: every consumer must work when it is absent. (3) A sidecar whose `subject` hashes do not match is rejected whole, never used partially. (4) Not exported to the browser in this cycle; `export_web.py` ignores it. (5) Promotion to 1.0, or folding into `song_analysis` 1.1, needs an approved migration plan with old and new fixtures. |
| Validation | `audiolab validate` gains sidecar support, which is additive. Fixtures include valid, hash-mismatch, unknown-field and wrong-version cases. |
- **Browser formats.** Additive keys keep the `/1` suffix, because parsers ignore unknown keys (VERIFIED). Any change to channels, order, binary layout or units requires `/2`, with parsers accepting `/1` and `/2` during a stated transition.
- **`AudioFeatureFrame`.** The meaning of existing fields does not change. `beatDetected` stays "one-frame onset pulse, not a beat grid". New data, if ever needed, arrives as new optional fields with tests.

### 9.2 Definitions every contract must state (PROPOSED)

| Item | Rule |
|---|---|
| Units | Per field. Seconds for times; Hz; "dB re X"; ratio; 0..1 |
| Missing values | `null` in JSON (never NaN, never 0 as a sentinel). Arrays are empty, not absent. TS parsers map absent optional fields to `undefined` and fail on wrong types. |
| Versioning | Python `schema_version` is semver. Web `format` is `name/major`. |
| Numeric tolerance | float32 data: Python against TS ≤ 1e-6 absolute on 0..1 values and ≤ 1e-4 dB on dB values (PROPOSED, confirmed against the M3 fixture). Times: exact to 1e-9 s when computed from integers. |
| Parity | One fixture set in `fixtures/contracts/`, consumed by pytest **and** node tests. Each valid fixture must parse in both. Each mutated fixture (wrong order, unsorted beats, bad format, NaN, wrong byte length) must be rejected by both. |

### 9.3 Exporter

`scripts/export_web.py` remains the compatibility boundary. In M3 it additionally:

- validates against the new JSON Schemas;
- checks that `nFrames · 4 · channels` equals the binary length;
- checks that `durationS` agrees with the source analysis;
- stamps the exporter version and a config hash.

The emitted format stays unchanged.

---

## 10. Reproducibility record (required for every analysis and evaluation)

| Item | Status |
|---|---|
| Input sha256 and size | VERIFIED present (`source`) |
| Analysis config (effective) | VERIFIED present (`provenance.config`) |
| Python and library versions | Present; **missing `soxr` and `audioread`** (added in M3) |
| Resampler (`res_type`) | **Missing** (added in M3) |
| Random seeds | None used in Python (VERIFIED). Browser scene PRNG seeds must be fixed or recorded in any visual test (squall seeding UNKNOWN, checked in M0). |
| Environment snapshot | `pip freeze`, the npm hidden lockfile and `npm ls` (M0) |
| Byte reproducibility of `analysis.npz` | **Not required this cycle (decided).** INFERRED cause of instability: `np.savez` writes members via `zipfile.open(name, 'w')`, which stamps the current local time into each ZipInfo. This is **not yet an established limitation**. M0 (A13) records each member's `date_time`, CRC, sizes and compression for runA and runB, and determines whether timestamps are the **only** byte difference. Equivalence is judged separately on key sets, shapes, dtypes, exact values (NaN positions included), JSON metadata and serialised bytes. |

---

## 11. Three.js integration (M4a, smallest boundary)

Copied from the working copy, which is left unmodified:

- `src/lib/gl/{host,state}.ts`
- `src/lib/accretion/{params,animator,scene,shaders}.ts`
- `src/components/accretion/{Accretion,AccretionCanvas}.tsx`
- `src/app/lab/accretion/page.tsx`
- `tests/gl-host.test.ts`, `tests/accretion*.test.ts`
- `preview/{accretion-entry.tsx, accretion.html, accretion-check.mjs, serve-gl.mjs, cdp-lib-gpu.mjs}`

Changed:

- `web_kit/package.json`: exact `three` 0.186.1 and `@types/three` 0.186.0.
- `web_kit/package-lock.json`, created **only after an impact assessment** at the start of M4a. The assessment generates a candidate with `npm install --package-lock-only` in a disposable copy, diffs it against the M0-captured hidden lockfile and `npm ls`, and reports any version that would differ from what is installed. You approve before the lockfile lands in live.

This is the first dependency change in the cycle.

Excluded: `GlCanvas.tsx` and the `glhost` harness, Spectrum Matrix, Constellation Core (M4c), generated `dist/` and `shots/`.

New tests that turn UNKNOWN items into VERIFIED:

1. 50 mount/unmount cycles: host and scene counters balance, `renderer.info.memory` returns to baseline, and the listener count is unchanged.
2. Same-canvas remount, which tests the StrictMode risk.
3. Context loss **during playback**, then restore.
4. Forced unsupported WebGL (`--disable-3d-apis`): the alert shows and the Canvas routes still work.
5. All existing Canvas browser checks pass unchanged.

---

## 12. Acceptance criteria

Thresholds marked "after baseline" are fixed only once M0 or M5 data exists.

| Area | Criterion |
|---|---|
| Regression | pytest passes at least the M0 count with no new failures. Node: the 99 live tests plus added tests. tsc exit 0. Raw outputs archived per milestone. |
| Archives | All existing snapshot manifests verify with 0 mismatches before and after every milestone |
| Live untouched by M0 | Live re-hash at the end of M0 equals the M0 manifest |
| Determinism | Two analyze runs per song, each property reported separately: npz key set equal; per array shape, dtype and exact values (NaN positions included) equal; JSON semantically equal after excluding only `provenance.created_at` and the npz-derived `curves.sha256`; any other JSON difference is a FAIL. Byte-level differences (npz and JSON hashes, zip member metadata) are reported separately and are not a FAIL this cycle. |
| Golden | `audiolab motion check` and `audiolab visual check` pass on M0 golden outputs |
| Beat accuracy (pilot) | Reported per track and tempo band. M2 is accepted only if mean AMLt and F-measure do not fall and the number of octave errors does not rise. A track losing more than 0.05 F-measure blocks acceptance unless explained. This is preliminary evidence (D1). |
| Octave errors | Every pilot track gets an octave class. M2 must not turn a correct track into half or double. |
| Confidence | `null` throughout the pilot (D1) |
| Validation | Each §8 case has a fixture and a test with the specified outcome |
| Parity | Both runtimes accept and reject the same fixtures, within §9.2 tolerances |
| Live versus offline | ≥ 5 recordings logged (append-only JSON-lines) with recording sha256, browser version, sample rate and latency. Per field: Pearson, mean absolute error, RMSE, bias, lag (cross-correlation peak); onset precision and recall at ±50 ms. Thresholds after baseline. |
| WebGL | §11 tests 1–5 pass, headed, on the §3.1 laptop |
| Performance | Recorded: p50, p95 and p99 frame interval and the share over 33.3 ms, 60 s × 3 runs, DPR 1.0 and 1.5. Provisional floor: p95 ≤ 33.3 ms. The 60 FPS target is aspirational. Final thresholds after baseline. |
| Startup and bundle | Median of 10 cold loads to first WebGL frame; esbuild metafile raw and gzip per entry. Canvas entries must not grow. |

---

## 13. Trade-offs: decided 2026-10-14, with remaining open items

| # | Trade-off | Decision |
|---|---|---|
| T1 | Where experimental analysis fields go | A **separately versioned sidecar** (`audiolab.analysis_extras` 0.x) during the pilot. The public `song_analysis` 1.0.0 contract is preserved. The sidecar schema, version, provenance and compatibility rules (§9.1) are specified and approved before it is introduced. |
| T2 | `analysis.npz` byte stability | **Not required this cycle.** Arrays, shapes, dtypes, metadata and values are compared separately. ZIP timestamp metadata is investigated in M0 (A13) before byte instability is treated as an established limitation. |
| T3 | Validation strictness | **Reject** corrupt, empty and non-finite input. **Warn** on silence, clipping and low sample rate at explicit thresholds (§8). Every warning, rejection, clamp and correction is recorded, and invalid data is never silently concealed. |
| T4 | Lockfile timing | M0 **captures** the existing environment. `package-lock.json` is deferred to M4a, after documenting the current state and assessing the lockfile's impact (§11). |
| T5 | Live/offline lag (100 vs 50 ms) | Investigated in **M3** with a controlled, reproducible measurement (§3.5). The original observations are preserved and no cause is assumed. |

Still open; defaults apply until you say otherwise:

| # | Item | Default |
|---|---|---|
| O1 | Pilot statistical power (8–12 tracks) | Per-track paired results; no significance claims |
| O2 | Single annotator | Intra-annotator repeat on 2 tracks; a second annotator is optional |
| O3 | Python lock tool | None. `pip freeze` is recorded (M0). |
| O4 | §8 threshold values | PROPOSED values, revised against the M0 characterisation (A12) before M3 |
| O5 | M0 behaviour when a test suite fails | Record FAIL and continue the independent baseline steps. Integrity problems halt (Appendix A.4). **Needs your confirmation.** |

## 14. Optional improvements (priority order, each gated)

1. Tempo candidates and an octave flag in the sidecar (part of M2).
2. Novelty peak parameters in config and provenance (additive).
3. Region annotations on 4–6 pilot tracks, to evaluate novelty peaks as boundary candidates. Peaks stay labelled "novelty peak", never "section".
4. A JSON-lines evaluation history across milestones.
5. A Canvas 2D visual fallback for WebGL routes, reusing `ConstellationCanvas`.
6. Adaptive DPR in `GlHost`, driven by measured p95.

## 15. Rollback

- The M0 snapshot is the known-good state. Restore it with `robocopy` into a **new** location, as the existing READMEs prescribe.
- The working copy and the existing archives are never written.
- Each milestone keeps `milestones/Mx.md` listing touched files and their pre-change hashes.

## 16. Risks and dependencies

| Risk | Mitigation |
|---|---|
| No annotations exist yet | M1 is blocked on your pilot audio and annotation time |
| Single integrated GPU | Results are labelled with hardware and never generalised |
| Headless-only WebGL evidence | Headed runs in M4 and M5 |
| `extra="forbid"` | §9.1 |
| The guidance document was truncated | Only the verified portions are used (§6) |

**Order:** M0 → M1 → (M2 ∥ M3) → M4a → M5 → M4c.

---

## Appendix A: M0 operational checklist (PROPOSED; not started; requires explicit approval)

### A.1 Paths

| Name | Path | Role |
|---|---|---|
| `LIVE` | `C:\Users\USER\Desktop\audio_lab` | Protected. Read only. |
| `ARCH` | `C:\Users\USER\Desktop\audio_lab_snapshots\2026-10-12_step0_pre-accretion`, `...\2026-10-13_pre-accretion-impl`, `...\2026-10-13_live-dist-evidence` | Protected. Read only. |
| `WORK` | `C:\Users\USER\Desktop\audio_lab_work\2026-10-13_accretion-v0` | Protected. Read only (hashed, not otherwise used). |
| `TOOLKIT` | `C:\Users\USER\Desktop\Python_Toolkit` | Protected. Only `imports\audio_lab*` is read (hashed). |
| `STAGE` | `C:\Users\USER\AppData\Local\Temp\claude\c--Users-USER-Desktop-audio-lab\231f7672-2c38-4096-890f-e04699a5d835\scratchpad\m0` | **New.** Helper scripts and pre-snapshot evidence, so that archives are verified *before* the snapshot exists. Copied into `SNAP` at A21. |
| `SNAP` | `C:\Users\USER\Desktop\audio_lab_snapshots\2026-10-14_pre-upgrade-m0` | **New.** Rollback snapshot and baseline evidence. |
| `RUN` | `C:\Users\USER\Desktop\audio_lab_m0_run` | **New, disposable.** Every test, browser check and analysis runs here. The path has no spaces, which `preview/serve.mjs` requires: it derives its root from a URL path. |

Interpreter: `LIVE\.venv\Scripts\python.exe`. It is used read-only, with these environment variables:

- `PYTHONPATH=RUN\src`, which overrides the editable `.pth` that points at `LIVE\src`;
- `PYTHONDONTWRITEBYTECODE=1`;
- `PYTHONNOUSERSITE=1`;
- `PIP_DISABLE_PIP_VERSION_CHECK=1`.

### A.2 Operations that write files

| # | Operation | Location |
|---|---|---|
| W1 | Create `STAGE`; write helper scripts (hashing, verification, comparison, fixture generation) and pre-snapshot evidence | `STAGE` |
| W2 | Create `SNAP`; robocopy the live source; write manifests, `env\`, docs, `baseline\` evidence | `SNAP` |
| W3 | Create `RUN`; robocopy from `SNAP\audio_lab` and from `LIVE\web_kit\node_modules`; tests and checks write their normal outputs (`shots\`, `m0_det\`, `m0_inputs\`, `m0_inputs_out\`) | `RUN` |
| W4 | Side effects of the tools themselves | `%TEMP%`: Edge profiles (`edge-cdp-*`; the scripts delete them), `squall-check-*` work dirs, pytest `basetemp`. `%LOCALAPPDATA%\npm-cache\_logs`: npm logs. |

Nothing is written to `LIVE`, `ARCH`, `WORK` or `TOOLKIT`. Nothing is deleted, overwritten, installed, upgraded or repaired. robocopy is never given `/MIR`, `/PURGE` or `/MOV`.

### A.3 Strictly read-only operations

- Hashing the files of `ARCH`, `LIVE` (source, `.venv`, `web_kit\node_modules`), `WORK` (excluding `node_modules` and `env\venv-py311`) and `TOOLKIT\imports\audio_lab*`. Each is hashed before and after M0.
- Reading manifests and `HASHES.csv`.
- `npm ls --all`, cwd `LIVE\web_kit`.
- `python -m pip freeze` and `python -m pip list --format=json`.
- Version queries: python, node, npm, tsc, Edge, robocopy.
- CIM hardware and OS queries, `Get-PSDrive`, `Get-NetTCPConnection`.
- Reading `LIVE` as the robocopy source.
- Reading Squall PRNG source (A19).

### A.4 Stop conditions

On any of the following, **halt** M0 immediately: no further steps run, nothing is repaired, deleted or retried, and the report is written from `STAGE` or `SNAP`.

1. `SNAP` or `RUN` already exists, or any computed path falls outside the A.1 roots.
2. A reparse point (junction or symlink) is found in any tree to be copied.
3. Any destination path is 240 characters or longer. Measured maximum: 166 for `SNAP`, 148 for `RUN`.
4. Free space is below the A6 requirement.
5. A missing prerequisite: `python.exe`, `node`, `npm`, `tsc` in `LIVE\web_kit\node_modules\.bin`, `robocopy`, or Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`; or ports 5353 or 9333 already in use; or the preview server not answering within 30 s.
6. An archive mismatch: a hash, size, missing file or unlisted extra file in the 2026-10-12 or 2026-10-13 manifests, or a `Live_*` mismatch in `HASHES.csv`.
7. A live file set that differs from the 2026-10-13 manifest in any way other than the expected addition of `AUDIO_LAB_UPGRADE_SPEC.md`.
8. robocopy exit code 8 or higher, or any copy-verification difference.
9. The import gate (A11) shows `audiolab` resolving anywhere except `RUN\src`.
10. Any pre/post hash difference in `LIVE`, `.venv`, `node_modules`, `ARCH`, `WORK` or `TOOLKIT` (A20).
11. An ambiguous result: a command whose argument form, output location or meaning differs from this checklist.

**Not a halt (decision O5, needs your confirmation):** a test-suite FAIL, a browser-check FAIL, a semantic determinism difference, or a characterisation outcome. These are baseline findings. They are recorded as FAIL or observed, and M0 continues with the independent steps.

### A.5 Status per step

| Status | Meaning |
|---|---|
| **PASS** | The command ran with its expected exit code, and the evidence file exists |
| **FAIL** | The command ran, but its result is negative |
| **BLOCKED** | A prerequisite was missing. This triggers a halt. |
| **NOT RUN** | Skipped because of an earlier halt |

Every step records step id, status, command, cwd, start and end time, exit code, stdout/stderr file and evidence file in `SNAP\baseline\RESULTS.csv`. Characterisation steps are PASS when the observation was captured; the behaviour itself is reported separately as observed fact.

### A.6 Steps

| Step | Kind | Action (shell) | Evidence |
|---|---|---|---|
| A1 | RO | Prerequisites (PowerShell): `Test-Path` for every A.1 target (new ones must be False); executables and versions; Edge path; ports 5353 and 9333 free; reparse-point scan of `LIVE` and `ARCH`; maximum destination path lengths | `STAGE\preflight.json` |
| A2 | W1 | Create `STAGE`; write the helper scripts. They only read, hash, compare, and write to `STAGE`, `SNAP` or `RUN`. Their exact text is archived at A21. | `STAGE\scripts\*.py`, `*.ps1` |
| A3 | RO | **Verify existing archives before any snapshot work.** For `2026-10-12` (columns Path,Sha256,Bytes) and `2026-10-13` (columns Path,Bytes,Sha256), read the CSV by header names; `Get-FileHash SHA256` for every file under `audio_lab\`; compare hash and size; list missing and extra files. For `live-dist-evidence`, compare `squall.js` and `squall.css` with `HASHES.csv` `Live_SHA256` and `Live_Bytes`. | `STAGE\archive_verification.csv` |
| A4 | RO | **Pre-copy hashes.** `LIVE` source, with these exclusions: `.venv\`, `web_kit\node_modules\`, `src\audiolab.egg-info\`, any `__pycache__\`, any `.pytest_cache\`. Writes a manifest (Path,Bytes,Sha256: the 2026-10-13 format) and compares it with the 2026-10-13 manifest (stop condition 7). Also hashes `.venv`, `web_kit\node_modules`, `WORK` and `TOOLKIT\imports\audio_lab*` as the "before" state. | `STAGE\live_manifest.csv`, `STAGE\protected_before\*.csv`, `STAGE\changes_since_2026-10-13.csv` |
| A5 | RO | Environment: `npm ls --all` (cwd `LIVE\web_kit`); `pip freeze`; `pip list --format=json`; copy-read of `.venv\pyvenv.cfg` and `web_kit\node_modules\.package-lock.json`; tool versions; CIM hardware and OS | `STAGE\env\*` |
| A6 | RO | **Space check, measured now.** Required = source bytes (185,153,889 as measured 2026-10-14; recomputed here) + `RUN` copy (source + 73,052,142 for `node_modules`) + 2 × existing `outputs` bytes (103,398,799) for the analysis runs + 100 MB for fixtures, shots and logs + **2 GiB margin**. That is 2,902,498,766 bytes (about 2.90 GB) today, against 31,690,764,288 free. Halt if free < required. | `STAGE\space.json` |
| A7 | W2 | Create `SNAP`. `robocopy "C:\Users\USER\Desktop\audio_lab" "C:\Users\USER\Desktop\audio_lab_snapshots\2026-10-14_pre-upgrade-m0\audio_lab" /E /COPY:DAT /DCOPY:T /XJ /XD "C:\Users\USER\Desktop\audio_lab\.venv" "C:\Users\USER\Desktop\audio_lab\web_kit\node_modules" "C:\Users\USER\Desktop\audio_lab\src\audiolab.egg-info" __pycache__ .pytest_cache /R:1 /W:1 /NP /LOG:"C:\Users\USER\Desktop\audio_lab_snapshots\2026-10-14_pre-upgrade-m0\robocopy.log"` | `SNAP\robocopy.log`, exit code |
| A8 | RO+W2 | **Copy verification, both ways.** Hash `SNAP\audio_lab`; the file set, sizes and hashes must equal `STAGE\live_manifest.csv` exactly. | `SNAP\copy_verification.csv` |
| A9 | W2 | Write `SNAP\MANIFEST.sha256.csv` (= the A4 manifest), `SNAP\README.txt` (purpose, date, counts and bytes, restore with `robocopy ... /E /COPY:DAT` into a **new** location only) and `SNAP\EXCLUSIONS.txt` (rules, plus counts and bytes per excluded tree, including the `.venv` 524,493,430 vs 128,175,232 discrepancy as an observation). Copy `STAGE\env\*` to `SNAP\env\`. | `SNAP\*` |
| A10 | W3 | Create `RUN`: `robocopy "<SNAP>\audio_lab" "C:\Users\USER\Desktop\audio_lab_m0_run" /E /COPY:DAT /DCOPY:T /XJ /R:1 /W:1 /NP /LOG:<SNAP>\baseline\robocopy_run.log`, then `robocopy "C:\Users\USER\Desktop\audio_lab\web_kit\node_modules" "C:\Users\USER\Desktop\audio_lab_m0_run\web_kit\node_modules" /E /COPY:DAT /DCOPY:T /XJ /R:1 /W:1 /NP /LOG:<SNAP>\baseline\robocopy_run_nm.log`. Verify both by hash against `SNAP\MANIFEST.sha256.csv` and the A4 `node_modules` hashes. | `SNAP\baseline\run_copy_verification.csv` |
| A11 | RO | **Import gate** (Git Bash, cwd `RUN`, A.1 env): `python -c "import sys, audiolab; print(audiolab.__file__); print(sys.path[:4])"`. The first line must start with `C:\Users\USER\Desktop\audio_lab_m0_run\src`. Also capture `python -m audiolab --help`, `python -m audiolab visual check --help` and `python -m audiolab motion check --help` to confirm argument forms (stop condition 11). | `baseline\import_gate.txt`, `baseline\cli_help.txt` |
| A12 | W3 | **Input characterisation** (current behaviour only; nothing fixed). `python -I STAGE\scripts\gen_inputs.py RUN\m0_inputs` writes: `silence_5s.wav`, `quiet_-70dBFS.wav`, `sine_-0.5dBFS.wav`, `clipped_sine.wav`, `stereo_48k.wav`, `mono_8k.wav`, `phase_inverted_stereo.wav`, `nan_float32.wav`, `empty_0byte.wav` and `text_named.wav`. Then, for each, `python -m audiolab analyze "m0_inputs/<f>" --out m0_inputs_out`. Record exit code, stderr, files produced, and any NaN or Inf in a produced npz. | `baseline\input_characterisation.json` |
| A13 | W3 | **Determinism.** For each of `Seyi-Vibez-SWAGUU-feat-Quavo.mp3`, `Detty - Party scatter demo.wav` and `Jeriq- airplane mode (Lyrics video) - Jeriq thehussla.mp3`: `python -m audiolab analyze "<song>" --out m0_det/runA`, then the same with `runB`. Then `python STAGE\scripts\compare_runs.py m0_det/runA m0_det/runB outputs` reports separately: (1) npz key sets; (2) per array, shape, dtype, exact values and NaN positions; (3) JSON semantic equality, excluding only `provenance.created_at` and `curves.sha256`, with every other difference listed; (4) **byte level**: file sha256 of npz, JSON and other outputs, plus per-zip-member `date_time`, CRC32, sizes and compress type, and whether timestamps are the only npz difference. It compares runA with runB (determinism) and runA with the existing `outputs/` (golden reproduction, with library versions shown). | `baseline\determinism.json`, `.md` |
| A14 | W3 | **Golden checks** (Git Bash, cwd `RUN`). `python -m audiolab validate outputs/*/song_analysis.json outputs/*/song_interpretation.json outputs/*/visual/visual_mapping.*.json outputs/*/visual_baseline_v1/visual_mapping.*.json`. `python -m audiolab motion check outputs/*/motion/motion_timeline.*.json`. `python -m audiolab visual check outputs/*/visual/visual_mapping.*.json`. | `baseline\golden_checks.txt` |
| A15 | W3 | **Python suite.** cwd `RUN`: `python -m pytest -q -p no:cacheprovider --junitxml=<SNAP>/baseline/pytest.junit.xml` | `baseline\pytest.txt` |
| A16 | RO | **TypeScript.** cwd `RUN\web_kit`: `node_modules/.bin/tsc --noEmit -p tsconfig.json` | `baseline\tsc.txt` |
| A17 | RO | **Node tests.** cwd `RUN\web_kit`: `node --import ./tests/resolve-ts.mjs --experimental-transform-types --test tests/*.test.ts` | `baseline\node-tests.txt` |
| A18 | W3 | **Browser checks.** cwd `RUN\web_kit`. Start `node preview/serve.mjs 5353` in the background and wait until `http://localhost:5353/instrument` returns 200 (≤ 30 s). Run `node --import ./tests/resolve-ts.mjs --experimental-transform-types preview/cdp-check.mjs` (exits 1 if any check fails; headless, `--disable-gpu` as written). Run `node --import ./tests/resolve-ts.mjs --experimental-transform-types preview/squall-check.mjs` (no arguments = all sections; exits 1 on failure). Stop the server by PID. Copy `RUN\web_kit\shots\*` to evidence. The existing `preview/dist` bundles are used as found, with no rebuild. | `baseline\browser\cdp-check.txt`, `squall-check.txt`, `shots\` |
| A19 | RO | **Seeds.** Read the Squall PRNG seeding in `RUN\web_kit\src\lib\squall\*.ts` and record whether the browser checks are seeded | `baseline\seeds.md` |
| A20 | RO | **Protected trees unchanged.** Re-hash `LIVE` (A4 rules), `.venv`, `web_kit\node_modules`, `ARCH` (re-run A3), `WORK` and `TOOLKIT\imports\audio_lab*`. Each must equal its "before" state (stop condition 10). | `baseline\protected_after.csv` |
| A21 | W2 | Copy `STAGE` (scripts and pre-snapshot evidence) to `SNAP\baseline\pre_snapshot\`. Write `SNAP\baseline\BASELINE.md` (every step, status and evidence; open items) and `SNAP\baseline\RESULTS.csv`. Write `SNAP\SNAPSHOT_SELF.sha256.csv`, hashing everything in `SNAP` except itself. | `SNAP\baseline\*` |

### A.7 Expected artifacts

```
C:\Users\USER\Desktop\audio_lab_snapshots\2026-10-14_pre-upgrade-m0\
  audio_lab\                       verified copy of live source (≈359 files, ≈185 MB)
  MANIFEST.sha256.csv              Path,Bytes,Sha256 (2026-10-13 format)
  README.txt  EXCLUSIONS.txt  robocopy.log  copy_verification.csv  SNAPSHOT_SELF.sha256.csv
  env\        npm-ls.txt  node_modules.package-lock.json  pip-freeze.txt  pip-list.json
              pyvenv.cfg  versions.json  hardware.json
  baseline\   BASELINE.md  RESULTS.csv  archive_verification.csv  changes_since_2026-10-13.csv
              space.json  import_gate.txt  cli_help.txt  run_copy_verification.csv
              input_characterisation.json  determinism.json  determinism.md  golden_checks.txt
              pytest.txt  pytest.junit.xml  tsc.txt  node-tests.txt  seeds.md
              browser\ (cdp-check.txt, squall-check.txt, shots\)  protected_after.csv
              pre_snapshot\ (scripts\, preflight.json, protected_before\)
C:\Users\USER\Desktop\audio_lab_m0_run\          disposable; kept for your inspection; deleted only on your instruction
```

### A.8 Rollback and duration

- **Rollback:** M0 creates only `SNAP`, `RUN` and `STAGE`. Undoing M0 means deleting them, and only on your instruction.
- **Duration:** UNKNOWN. A rough ESTIMATE is 30–60 min: pytest took 109 s (VERIFIED); 6 analyses cover 78 + 113 + 258 s of audio twice; there are 10 characterisation analyses; and hashing covers about 1.2 GB.
