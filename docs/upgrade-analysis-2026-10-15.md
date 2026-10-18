# AudioLab upgrade analysis (2026-10-15)

**Status:** analysis and decision report. No code, configuration, dependency, bundle or lockfile was changed to produce it. `AUDIO_LAB_UPGRADE_SPEC.md` revision 3 is the canonical baseline and is not modified here.

**Labels:** VERIFIED = read in source, in a test run, or in a measured output, with the reference given. INFERRED = follows from code or documentation but was not executed. UNKNOWN = not established.

**Scope of this file:** the source-tracing pass of 2026-10-15 (live and offline timing, the feature-bundle contract, WebGL restoration, build-tool ownership). It summarises the earlier proposal (addendum) and evidence report where they are still relevant, and lists every decision that is still open.

---

## 1. Newly verified facts

### 1.1 Live call flow (local file or URL source)

```
rAF callback loop(nowMs)                      pipeline.ts:130-134
 └─ tick(nowMs)                               pipeline.ts:143
     └─ src.sample(nowMs / 1000)              pipeline.ts:147          [nowS = rAF timestamp, seconds]
         RealtimeSource.sample(nowS)          realtime.ts:56
          ├─ dt = clamp(nowS − lastNow, 1e-3, 0.1)        realtime.ts:57-58 (first call: 1/60)
          ├─ time = head.time                              realtime.ts:60
          │    ElementBackend → element.currentTime        playhead.ts:112-113
          │    mic → ctx.currentTime − startedAt           webaudio.ts:182-183
          ├─ playing? computer.push(backend.read(), nowS, dt)   realtime.ts:64
          │           else computer.decay(dt)               (decay never calls onsets)
          │    push → shaper.push(punchDb, t, dt); follow(…, dt); onsets.pushFlux(flux, t)   computer.ts
          ├─ tracker.push(rms, dt) while playing           realtime.ts:65
          ├─ live = makeFrame({time, progress: time/head.duration, …f, scene})   realtime.ts:66-71
          ├─ delay.push(nowS, live)                        realtime.ts:75
          ├─ delayS = clamp(latencyS + nudgeMs/1000, 0, 0.6)   realtime.ts:76
          └─ past = delay.at(nowS − delayS)                realtime.ts:77; audio/delay.ts `at`
             return makeFrame({...past, time, progress: live.progress, isPlaying})   realtime.ts:78-79
```

**Consequence:** the emitted frame's `time` is the current media position. Its audio features and scene state come from `delayS` seconds earlier, measured on the rAF clock. Latency is therefore not metadata only: it delays the features (VERIFIED). The UI says "compensated automatically" (`Controls.tsx:222`, `Squall.tsx:227`), which matches this behaviour.

### 1.2 Offline call flow

```
OfflineSource.sample(_nowS)                    offline.ts (constructor loop, then sample)
 t = head.time                                  ElementPlayhead element.currentTime, or SilentPlayhead
 x = max(0, t − nudgeS) · rate                  offline.ts:93
 linear mix of bass/mid/high/rms/hit between frames i0, i1; onset and beat from flag at i0
 time = t; no delay line; latencyMs = 0
 nudge clamp [−0.2, 0.4] s                      offline.ts:145
```

`_nowS` is unused (VERIFIED by its underscore name and absence in the body). Offline features are not delayed. A negative nudge advances them, reading future frames (VERIFIED from the arithmetic).

### 1.3 Clocks and time bases

| Quantity | Clock or origin | Label |
|---|---|---|
| Live `computer.push` time `t` | rAF timestamp in seconds (`nowS`) | VERIFIED |
| Live onset refractory and warm-up | `t` = `nowS`; warm-up counts calls, not seconds | VERIFIED (`features.ts` `pushFlux`) |
| Live features `dt` | rAF delta, clamped to [1e-3, 0.1] | VERIFIED |
| Live emitted `time` | element `currentTime`, or `ctx.currentTime − startedAt` for mic | VERIFIED |
| Live delay line key | rAF time (`nowS`) | VERIFIED |
| Offline onset `t` | `i · dt` with `dt = 1/rateHz`, i.e. window-end time of the frame | VERIFIED (`offline.ts` constructor, `computer.push(…, i*dt, dt)`) |
| Offline emitted `time` | element `currentTime` | VERIFIED |
| What the analyser read corresponds to in audio time | no timestamp is captured | UNKNOWN (the AnalyserNode returns data without a time stamp; spec-level, not measured) |

**Contradiction in revision 3 §4:** it says "render time = rAF timestamp: never an audio time base". In the live path, rAF time is the time base for the onset refractory and for the delay line, which decides when events fire. The sentence is true for rendering but not for events.

### 1.4 Latency and nudge

- `ElementBackend.latencyS` = `baseLatency + outputLatency` (`webaudio.ts:152-156`), read on every call, so it can change during playback (VERIFIED).
- `RealtimeSource.latencyMs` (`realtime.ts:52-54`) feeds pipeline state (`pipeline.ts:155-156, 188`) and the UI label.
- The delay (`realtime.ts:76`) is the only place latency changes features. It does not change playback position (VERIFIED).
- **Nudge path:** the UI slider (`Controls.tsx:214`, `Squall.tsx:223`) → `pipeline.setSyncNudge` (`pipeline.ts:114-116`, no clamp) → `realtime.ts:103-104` clamps to [−200, 400] ms → `delayS` clamps to [0, 0.6] s.
- **Asymmetry:** live cannot advance features (a negative total is clamped to zero delay). Offline can, through a negative nudge (VERIFIED from the clamps).
- **Measurement record:** `preview/cdp-check.mjs:113` captures `latencyMs` in the in-run snapshot, but `:221` writes only `lagMs` and `pearson`. The latency values behind the 100 ms and 50 ms figures are therefore not recorded (VERIFIED). `cdp-check.mjs` sets no nudge (VERIFIED by grep), so the nudge was presumably zero (INFERRED).

**Consequence for the lag question:** by design, live features lag offline features by about `latencyS + nudge`. A measured 50–100 ms lag is therefore expected to some degree, and it cannot be interpreted without `latencyS` and `nudge` at measurement time. Whether 100 and 50 ms reflect different device latencies is a hypothesis; the saved record cannot test it (UNKNOWN).

### 1.5 Onset history: behaviour and consumers

- `OnsetDetector` defaults: `historyLen = 43`, `k = 1.6`, `refractoryS = 0.12` (`features.ts`). `pushFlux` appends one entry per call; `n >= 8` gates warm-up.
- **Live:** one entry per playing read (about 60 per second), so about 0.72 s of history. **Offline:** one entry per 1024-sample frame, so 1.0 s (VERIFIED arithmetic from the call sites).
- The history is not reset. The only `.reset()` in the pipeline is not called from any source (VERIFIED: no `.reset(` in `src/lib/pipeline`). Pauses and seeks keep the history.
- **Consumers of `beatDetected` (VERIFIED):** Squall lightning (`squall/weather.ts:145`), particle bursts (`pipeline/ParticleField.tsx:69`), Accretion flare (`accretion/params.ts:96`), Constellation pulse (`constellation-core/params.ts:77`).
- **Consumers of `onsetStrength` (VERIFIED):** Instrument shock (`instrument/profiles.ts:89`), Squall lightning strength (`squall/weather.ts:146`), and the flare and pulse above.
- A change to the history length therefore changes which frames fire and how strong they are, visibly in every affected scene.

### 1.6 Duration origins

- **Offline timeline `durationS`:** `timebase.duration_s` (`motion/engine.py:475`) ← `Inputs.duration` (`engine.py:86`, from the mapping's timebase) ← `AnalysisContext.duration = a.source.duration_s` (`interpretation/context.py:84`) ← `song_analysis.json` source duration ← analysis load length (`pipeline.py:56`, `len(y)/sr` at 22050 Hz). The endpoints are VERIFIED. The middle links are INFERRED from the attribute chain; each file was not read end to end.
- **Features `durationS`:** `len(y)/44100` from a separate `librosa.load(sr=44100)` (`export_web.py:116`), a different decode and resample from the analysis.
- **Browser element `duration`:** `ElementPlayhead.duration` = `element.duration` (`playhead.ts`). It is not compared with either source.
- **Two progress definitions:** live uses element duration (`realtime.ts:69-70`); offline uses timeline duration (`offline.ts:107-110`). Undocumented.
- **Checks:** `offline.ts:202` requires `|features − timeline| ≤ 0.25 s`. That is about 10.8 feature frames, so it cannot detect a per-frame offset smaller than 0.25 s (VERIFIED arithmetic). `parse.ts:129` requires the timeline's last state to end within `2/rateHz` of `durationS`.
- **Out-of-range reads:** `offline.ts` clamps the index to `n−1`, so reads past the end repeat the last frame silently (VERIFIED).

### 1.7 Analysis framing (librosa 0.11.0, from the installed `.venv`)

| Call | Parameter | Value and source | Effect |
|---|---|---|---|
| `librosa.stft` (`features.py`) | `center` | default `True` (`spectrum.py:62`) | frame k centred at `k·512/22050` |
| same | `pad_mode` | default `"constant"` (`spectrum.py:64`) | zero padding; frame 0 is half zeros |
| `librosa.feature.rms` | `center` | default `True` (`spectral.py:55`) | centred |
| `librosa.onset.onset_strength` | `center` | default `True` (`onset.py:225`) | centred |
| `librosa.beat.beat_track` (`beats.py`) | `start_bpm`, `tightness`, `trim`, `units` | `120`, `100`, `True`, `'frames'` (`beat.py:42-47`) | `trim=True` removes leading and trailing weak beats, so the first beat need not be near 0 (signature VERIFIED; effect INFERRED) |
| `librosa.frames_to_time` | `n_fft` | default `None`, so no `n_fft//2` offset (`convert.py:66, 95-119`) | beat time = frame·512/22050 (centre convention) |
| `librosa.onset.onset_detect` (`events.py`) | `units='time'` | same frame-to-time convention | consistent |
| `librosa.load` | `res_type` | default `"soxr_hq"` (`audio.py:66`) | both the 22050 and 44100 loads use it; the export does not pass it explicitly |

**Frame zero and window boundaries (feature readings, `webfeatures.py`):**
- `magnitudes` pads `fft_size` zeros before the signal. Frame k covers original samples `[k·hop − fft, k·hop)`, so its time is the window end, `k·hop/rate` (VERIFIED).
- Frame 0 covers only padding. All its bands read −120 dB and its flux is 0 (VERIFIED from code; values by arithmetic).
- Frame count is `1 + len(y)//hop`. The test `test_frame_count_and_channels` asserts this for two seconds (VERIFIED).

**Beat timestamps:** beat frames → `librosa.frames_to_time` → float seconds → `round(…, 4)` in `export_features` (`export_web.py`) → `features.json` `beats`. The TypeScript parser requires numeric, sorted values (`features-bundle.ts`). The browser builds `beatDetected` from onset flags, not from beats (VERIFIED, `offline.ts` `beatFlag`). `beats` is exposed on `OfflineSource`; the only consumer found is the `cdp-check` count. Other consumers are UNKNOWN.

### 1.8 The six `features.bin` channels

Layout: float32 little-endian, channel-major, order `lowDb, punchDb, midDb, highDb, allDb, flux` (`features-bundle.ts`; `export_web.py` concatenation). Byte count = `6 · nFrames · 4`.

| Channel | Bins (4096 or 2048 FFT) | Smoothing | Formula (`webfeatures.py` `band_db`) |
|---|---|---|---|
| `lowDb` | 20–150 Hz, 4096 → bins [1, 14) (test-asserted) | 0 | `10·log10(mean(mag²) + 1e-12)` |
| `punchDb` | 60–150 Hz → [5, 14) (test-asserted) | 0 | same |
| `midDb` | 150–2000 Hz, 2048 → [6, 93) (arithmetic from `bin_range`) | 0.5 | same |
| `highDb` | 2000–10000 Hz → [92, 465) (test-asserted) | 0.5 | same |
| `allDb` | 20–10000 Hz → [1, 465) (arithmetic) | 0.5 | same |
| `flux` | bins [1, 186), i.e. up to 4 kHz (arithmetic) | 0.5 | `Σ max(0, mag_k − mag_prev_k)` on smoothed magnitudes |

- **Magnitude scale:** `|rfft(blackman · x)| / N`, Blackman α = 0.16. This is the AnalyserNode convention as the module describes it. Whether live AnalyserNode output matches exactly is INFERRED from the spec, not measured.
- **Dynamic range for |x| ≤ 1 (VERIFIED arithmetic):** each normalised magnitude is ≤ `Σw/N = 0.42`, so band power ≤ 0.1764, i.e. ≤ **−7.54 dB**. Lower bound **−120 dB** (the `1e-12` floor). Smoothing is a convex combination, so the bounds still hold. Nothing in the code enforces |x| ≤ 1; `librosa.load` returns float32 in that range for standard decodes.
- **Flux:** non-negative, finite, bounded by about `0.42 · 185 ≈ 78` (loose).
- **Live band equivalence:** `bandDb` (`src/lib/audio/features.ts:24-31`) computes `10·log10(mean(10^(db/10)) + 1e-12)`. With analyser dB = `20·log10(mag)`, this is the same power mean as the emulator (VERIFIED arithmetic; the input relation INFERRED).
- **Live sample rate:** `new AudioContext()` has no `sampleRate` option (`webaudio.ts:137, 244`), and `binRange` uses `ctx.sampleRate` (`webaudio.ts:34-40`). Live band edges therefore follow the device rate, while offline uses 44100 Hz (VERIFIED). The revision 3 requirement for a fixed AudioContext rate (§3.5, M3) is not in the code.
- **Finiteness:** Python does not check before writing (`export_features`). TypeScript rejects non-finite values (`decodeFeatureChannels`). The dB values are always finite, so this is a defence, not a current failure.

### 1.9 `rateHz`, `nFrames`, `durationS`

- `rateHz`: written as `r6(44100/1024)` = **43.066406**, against the exact 43.06640625 (VERIFIED). The loader uses it for `x = t·rate` (`offline.ts:93`). The error at 300 s is about 7.5e-5 frames (VERIFIED arithmetic), which is negligible. The schema should still carry the exact integers, not a rounded float.
- `nFrames`: array length; `parseFeaturesMeta` requires ≥ 2 (`features-bundle.ts`). It is not checked against `durationS × rateHz`.
- `durationS`: used only by the 0.25 s check (`offline.ts:202`). It does not drive indexing.

### 1.10 Provenance available today

| Record | Contents | Label |
|---|---|---|
| `song_analysis.json` → `source` | song `sha256`, size, durations, original and analysis sample rates | VERIFIED (`export.py` `build_song_analysis`) |
| `song_analysis.json` → `curves` | `file` = `analysis.npz`, `sha256` of `analysis.npz` (passed from `render_bars`, `pipeline.py`) | VERIFIED |
| `song_analysis.json` → `provenance` | `libraries` (numpy, scipy, librosa, soundfile, pydantic, PyYAML, matplotlib), `config` (`asdict`), analyzer params, `created_at`, Python version | VERIFIED |
| `AudioConfig` | `sample_rate` and `mono` only; **no `res_type`** | VERIFIED (`config.py`) |
| `features.json` `provenance` | `audioSha256` only | VERIFIED |
| `features.json` `extractor` | `sampleRate`, `hop`, `fftMain`, `fftLow`; **no smoothing, window function, or library version** | VERIFIED |
| Timeline vs feature source check | `export_web.py` compares the feature source's sha with the timeline's `audio_sha256` | VERIFIED |
| `analysis.npz` check | **none**: `np.load(analysis_npz)["beat_times"]` is read without a hash check | VERIFIED |

`render_bars` can rewrite `song_analysis.json` (new `created_at`, new settings) without changing `analysis.npz`, so its provenance and its curve hash can diverge over time (VERIFIED from `pipeline.py`).

### 1.11 Build-tool ownership

| Tool | Where referenced (live) | Label |
|---|---|---|
| esbuild | `preview/README.txt:2, 3, 9`; `research/*.md` (historical); `preview/dist/*` outputs. No source import, no config file, no `package.json` entry. | VERIFIED |
| tailwindcss | `preview/README.txt:2, 4, 10`; `tailwind.config.cjs` (present; not read here). Source mentions are class-name comments only (`SceneBackdrop.tsx:8`, `Scrubber.tsx:41`, `MotionPlayerProvider.tsx:308`). | VERIFIED |
| playwright-core | No reference in the live tree (grep over all files, excluding `node_modules`, `.venv`, `.git`). Present in the working copy's staging `env/js-lock/package.json` only. | VERIFIED (absence in live tree) |

**Documented commands (VERIFIED, `preview/README.txt`):**
- Install, line 2: `npm i -D react react-dom typescript @types/react @types/react-dom @types/node esbuild tailwindcss@3`.
- esbuild, development build, lines 3 and 9: `--define:process.env.NODE_ENV='"development"'`.
- tailwind, lines 4 and 10: no `--minify`.

**Production build command:** none documented in the repo. `--minify` appears only in `research/workspace-readiness-gate-2026-10-13.md:49`, which cites a session log (`c055ddcc`) outside the repo. That log is not available here, so the claim is UNKNOWN.

**Quoting explanation:** `research/workspace-readiness-gate-2026-10-13.md:53` hypothesises that PowerShell strips the inner quotes, turning the development define into an unquoted identifier. This is INFERRED by that document's author and is not verified here. The live `squall.css` size (35,764 bytes) matches the document's non-minified figure (VERIFIED).

**Installed records (VERIFIED):** `node_modules/.package-lock.json` (dated 2026-10-12 17:04) records `esbuild 0.28.2` with `hasInstallScript: true`, `@esbuild/win32-x64 0.28.2`, `tailwindcss 3.4.19`, `postcss 8.5.29`, and 9 entries with `dev: true`. No installed package lists esbuild or tailwindcss as a dependency. Root declarations are not written to this file (INFERRED from npm's format).

**Working-copy staging lock (VERIFIED):** `env/js-lock/package.json` declares `esbuild 0.28.2`, `tailwindcss 3.4.19` and `playwright-core 1.64.0`, written by `env/logs/edit-js-lock.cjs`. Platform-optional packages were inserted from registry metadata with `_reconstructed` markers (`add-optional-lock.cjs`), not from a resolution. Those entries are not a faithful lock.

### 1.12 Accretion clear colour (source only)

- `AccretionCanvas.tsx`: the mount effect calls `host.three?.setClearColor(0x020308, 1)` and passes no `onRestored` (VERIFIED).
- `ConstellationCoreCanvas.tsx:57` and `SpectrumMatrixCanvas.tsx:57` pass `onRestored` to re-apply their colours (VERIFIED).
- Three.js 0.186.1: `onContextRestore` (`WebGLRenderer.js:1123`) calls `initGLContext` (line 442), which recreates `WebGLBackground` (line 477). `WebGLBackground.js:21` initialises `clearColor` to black (VERIFIED).
- The grep found `setClearColor` calls at lines 931, 2056 and 2120, none within `initGLContext`'s start. The whole of `initGLContext` was not read, so "not re-applied" is INFERRED.

---

## 2. Corrections to the addendum and to revision 3

1. **Latency is not metadata.** Revision 3 §3.5 says "latency compensation is `baseLatency + outputLatency` (`webaudio.ts:155`)". The mechanism is the feature delay at `realtime.ts:74-79`. Lag figures must be read against that delay (§1.4).
2. **The live-versus-offline lag is partly designed.** Live features are intentionally delayed, so any cross-correlation lag must be read with `latencyS + nudge` recorded. The existing measurement does not record them.
3. **Revision 3 §4's "rAF never an audio time base" is incomplete.** rAF time drives onset refractory and the delay line (§1.3).
4. **The `timeBase` proposal needs changes.** Frame time is the window end, not the centre. Frame 0 is padding only. The beat grid is centred. Smoothing and the `rateHz` rounding are missing (§1.7–1.9).
5. **The addendum's `"rateHz": 22050/512` was not valid JSON.** Use numbers or integers.
6. **`webfeatures.py` says its window delay matches a live read.** That equivalence is not verified: the live AnalyserNode's window timing is UNKNOWN.
7. **Revision 3's offline index description is incomplete.** It gives `floor((currentTime − nudge)·rateHz)`. The code also interpolates four channels linearly (`offline.ts`, `mix`), and uses the floor index for onset and beat flags.
8. **The 0.25 s duration check** is described in the code as a consistency check. It is not documented as a timing tolerance and cannot catch sub-0.25 s offsets.
9. **Revision 3 requires a fixed AudioContext rate** (§3.5, M3). The code does not set one (`webaudio.ts:137, 244`).
10. **The "100 ms versus 50 ms" lag is not reproducible from the saved record**, since `latencyMs` was not written (`cdp-check.mjs:221`).

---

## 3. Remaining unknowns

- What audio the live AnalyserNode read corresponds to in time. The browser does not expose a timestamp for it; this needs a browser measurement.
- The `latencyS` and device sample rate behind the 100 ms and 50 ms runs.
- Element duration versus timeline duration for each committed song.
- Whether the live AnalyserNode's dB convention matches the emulator exactly.
- Whether `features.beats` is used anywhere beyond counts.
- Whether `initGLContext` re-applies the clear colour (a full read of the function body would settle it; not done here).
- Whether the minified bundle came from `--minify`, and whether the PowerShell quote-stripping mechanism is real. Both depend on session logs outside the repo.
- Who ran the installs without saving them to `package.json`.

---

## 4. Decision options, trade-offs and evidence needed

**D1. Onset history horizon.**
- A: keep the count-based history and document the per-path horizon (about 0.72 s live versus 1.0 s offline). Least change.
- B: time-based history in seconds, trimmed by timestamp as `DelayLine` does. This changes warm-up, threshold and strength, so it changes visuals.
- C: resample live reads onto the 43 Hz grid. Largest change, and it adds interpolation error.
- **Evidence needed:** the sensitivity of onset count and strength between 60 Hz-like hops and 43 Hz on the same audio. The emulator's `hop` argument supports this without a browser, once approved. Also the consumer-level effect on Squall lightning rate and particle bursts. Not yet run.
- **Recommendation for now:** do not change the history.

**D2. Latency delay policy.** Keep the designed delay and document it; or remove it and accept lower visual alignment; or apply an equivalent delay to offline, which currently has none. **Evidence:** runs that record `latencyMs`, `nudge` and `sampleRate`.

**D3. Nudge asymmetry.** Live cannot advance features; offline can. Options: clamp offline to ≥ 0 as well, or document it. Live cannot advance without lookahead, so the offline side is the one that would change. **Recommended:** document, do not change.

**D4. AudioContext sample rate.** Fix it (`new AudioContext({ sampleRate: 44100 })`), which is a playback-path change; or accept the device rate and record it per run. **Evidence:** device sample rates on the test machines, and whether the browser honours the requested rate.

**D5. Onset clock.** Keep rAF time (jitter up to one frame, about 16.7 ms at 60 Hz), or move to an audio-clock stamp for reads. The second needs an analyser timestamp that browsers do not expose, so it may be infeasible. **Evidence:** the jitter histogram from the browser cadence audit.

**D6. Duration and progress.** One definition for `progress`, and one source for duration. **Evidence:** element durations for the committed files.

**D7. Provenance additions.** `features.json` could reference `song_analysis.json`'s existing `curves.sha256`. Cheap and additive; belongs in the schema step.

---

## 5. Recommended order of work

1. **Timing (first).** Write down the live clock and the delay as they are (§1.1, §1.3). Decide D1 using offline hop-sensitivity data. Then run the browser cadence audit and a lag measurement that records `latencyMs`, `nudge` and `sampleRate`. All need approval.
2. **Export contract.** Describe the current `features.json` and `features.bin` exactly, including the units and bounds in §1.8 and the provenance gaps in §1.10. Check the consumers of `beats`, `rateHz`, `nFrames` and `durationS`. Decide D6 and the 0.25 s check. Propose additive fields only after that.
3. **Build-tool ownership.** Decide the declared set (esbuild and tailwindcss at major 3; playwright-core only if a consumer exists). Decide the shipped build mode (development is documented; production is not). Generate a project lock only after approval, and do not use the staging lock.
4. **WebGL.** Read the rest of `initGLContext` (read-only). Then, only with approval, add a browser readback of the clear colour after a forced loss and restore for each scene. Decide on `onRestored` for Accretion after that.

---

## 6. Explicitly deferred

- All tests, experiments and browser runs, including the cadence audit and the lag measurement.
- Any change to the onset history, the clock, the delay, the nudge, or the AudioContext sample rate.
- Any tolerance or threshold, including ±50 ms and the 0.25 s check.
- Any schema, `timeBase` field, fixture, or change to `features.json` or `features.bin`.
- Any dependency declaration, removal, install or lockfile generation.
- Any production or development build, and any bundle regeneration.
- Any change to `AccretionCanvas.tsx`, to `onRestored`, or to `GlCanvas.tsx`.
- Any new feature proposal from the librosa tutorial.
- Any change to revision 3 or to any other existing repository file.

---

## 7. Earlier proposal: summary of what remains open

The earlier addendum proposed five gap areas. Their status after this pass:

| Gap | Status |
|---|---|
| Live versus offline cadence, timing and smoothing | Traced (§1.1–1.5). Effect size unmeasured. Decisions D1, D2, D5. |
| Squall build reproducibility and undeclared esbuild | Documented commands and installed records traced (§1.11). Build mode and lockfile decisions open. |
| WebGL context loss and restoration | Source traced for Accretion, Constellation Core and Spectrum Matrix (§1.12). Browser test required before any change. |
| Explicit time-base conventions in `features.json` | Current behaviour traced (§1.7–1.9). Additive block to be proposed only after the current output is fully described. |
| Shared schemas and fixtures for the feature bundle | Not started. Waits on the export-contract step. |

The earlier proposed tests (cadence sensitivity, browser cadence audit, paired recordings, context-loss and unmount tests, bundle determinism and size, schema validation and cross-runtime decode) remain proposals. None has been run.
