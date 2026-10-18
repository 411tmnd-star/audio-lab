# Engineering notes: testing, determinism and robustness

How AudioLab is verified, and what the checks show. Every number below was measured on one machine
(Intel Core i5-10210U laptop, integrated Intel UHD graphics, Windows 11, Python 3.11, Node 24, Edge 155)
and comes from a recorded run, not an estimate.

## 1. Test baseline

| Layer | Tooling | Result |
|---|---|---|
| Python analysis, interpretation, visual mapping, motion | pytest | 388 tests pass (385 at the 2026-10-14 baseline, plus 3 regression tests for the silence fix) |
| Browser kit: parameters, scenes, animators, pipeline logic | Node test runner on TypeScript | 263 tests pass, 0 fail |
| Browser kit: type safety | `tsc --noEmit` | clean |
| Pipeline in a real browser (live audio vs. offline analysis) | Headless Edge over the DevTools Protocol | 13 of 13 checks pass |
| Constellation Core in a real browser, GPU enabled | Headless Edge, synthetic audio | 70 of 70 checks pass |
| Spectrum Matrix in a real browser, GPU enabled | Headless Edge, synthetic audio | 60 of 60 checks pass |

The browser checks drive scripted synthetic audio, so they need no copyrighted music and give the same input
on every run. They cover: reaction to bass, mid and high bands, silence settling, bass-hit response, reduced-motion
behaviour, five viewport and pixel-ratio combinations, tab hidden and restored, WebGL context loss and restore,
and the absence of page errors.

## 2. Determinism

The analysis stage is deterministic: the same audio and configuration give the same output.

Three songs were each analysed twice, and compared with outputs produced two days earlier.

- All 18 arrays in each `analysis.npz` match exactly: same keys, shapes, dtypes and values.
- `analysis.npz` is byte-identical across runs, because its members are stored uncompressed with a fixed timestamp.
- Events, bars, the click-track audio and all six plots are byte-identical across runs.
- The one file that differs is `song_analysis.json`, and only in `provenance.created_at`, the run timestamp.
  The recorded `curves.sha256` equals the SHA-256 of that run's `analysis.npz`, so the JSON can be checked
  against the arrays it describes.

Scope: same machine and same library versions. Other NumPy or librosa versions, hardware and operating systems
were not tested.

## 3. Robustness: how the analyzer treats unusual input

A set of synthetic 120 BPM pulse trains probes edge cases. Observed behaviour of the current analyzer:

| Input | Result |
|---|---|
| Normal, very quiet (-70 dBFS), clipped, 48 kHz stereo, 8 kHz mono | Accepted. All return 117.45 BPM and 38 beats. |
| Non-finite samples (NaN) | Rejected with a clear error before any output is written. |
| Zero-byte file, text file named `.wav` | Rejected with an error; no output written. |
| Digital silence | Rejected up front with a clear message and exit code 1. Nothing is written. |
| Stereo with the right channel inverted (cancels to silence when mono-mixed) | Rejected the same way. |

The first run of this suite (2026-10-14) found the last two cases crashing with an unhandled `ValueError` after
writing partial output. They are fixed: the analyzer now checks for a usable signal (peak above -80 dBFS) before
creating any output, so a -70 dBFS recording is still analysed. `beat_diagnostics` also no longer fails when there are
no beats to measure. Regression tests cover both. The upload demo additionally rejects silent, too-short and
beat-less files before the analyzer runs (see [DEMO.md](../../DEMO.md), "Minimum audio").

## 4. Live versus offline timing

The browser can play a song live, reading its own audio analysis, or follow the pre-computed offline analysis.
The pipeline check measures how closely the two agree on one recording: best lag 50 ms, with Pearson correlation
of 0.97 for bass, 0.94 for mid, 0.86 for high bands and 0.97 for overall energy.

## 5. Rendering performance

Measured on integrated graphics at 1280x720, device pixel ratio 1, over a 10-second synthetic demo:

| Visual | Frame interval median / p95 | Main-thread time per frame (median) | GPU time per frame (median) | Frames over 33 ms |
|---|---|---|---|---|
| Constellation Core | 16.7 ms / 17.2 ms | 0.9 ms | 4.9 ms | 0% |
| Spectrum Matrix | 16.7 ms / 17.1 ms | 0.5 ms | 4.4 ms | 0% |

Both hold 60 fps on integrated graphics. Memory growth over a 17-second run was about 0.5 to 0.6 MB.

## 6. Reproducing

Python tests, from the repository root: `python -m pytest`.

Browser kit, from `web_kit/`:

    npm test                                    # unit tests
    npx tsc --noEmit -p .                       # types
    node preview/build.mjs core matrix glhost   # bundle the WebGL previews
    node preview/serve-gl.mjs 5354              # serve them
    node --import ./tests/resolve-ts.mjs --experimental-transform-types preview/core-check.mjs

The GPU checks need a GPU-enabled Edge and, for the frame-pacing section, a laptop on AC power.
