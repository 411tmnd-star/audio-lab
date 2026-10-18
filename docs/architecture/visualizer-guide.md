# Visualizer architecture: the pattern behind every scene

How a visual is built in `web_kit/`, and what is shared across Squall, Accretion, Constellation Core and Spectrum Matrix. Each row notes whether the behaviour is covered by a test or browser check (**Verified**) or only present in code or not yet exercised.


## 1. The one rule

A visualizer is **two layers on top of a fixed audio contract**, plus an optional rendering host.

1. **Contract (shared, do not fork):** one `AudioFeatureFrame` per animation frame, delivered by one loop.
2. **Mapping (per scene, no renderer):** frame to parameters, then parameters to animation state.
3. **Renderer (per scene, any technology):** reads animation state, draws. It may be Three.js, Canvas 2D, or a custom shader.

Only layer 3 is technology-specific. Layers 1 and 2 are plain TypeScript and are tested in Node.

## 2. The reusable contract (applies to every visualizer)

| # | Element | What the code does | Status |
|---|---|---|---|
| 1 | **`AudioFeatureFrame`** (`pipeline/contract.ts`) | Frozen object per frame: `time`, `progress`, `isPlaying`, `bass`, `mid`, `high`, `rmsEnergy`, `onsetStrength`, `beatDetected`, `currentSceneState` (`rest/build/active/settle`), `bassHit`. Unit fields are 0..1 and finite (`makeFrame`). Bands: bass 20-150 Hz, mid 150-2000 Hz, high 2-10 kHz. `beatDetected` is a detected onset, not a beat grid. Offline, live and synthetic sources all produce the same shape. | Verified |
| 2 | **No spectrum, no waveform** | The contract carries three band levels and scalars only. The offline feature bundle (`audio-features/1`) has six channels (`lowDb, punchDb, midDb, highDb, allDb, flux`). No source can supply frequency bins or samples today. This shapes what scenes can honestly show: three bands, not a full spectrum. | Verified |
| 3 | **One frame clock** | `AudioPipeline.start()` runs a single `requestAnimationFrame` loop. Consumers use `useAudioFrame(cb)`: the callback is read through a ref, runs once on subscribe (so a paused scene still paints), then every frame. No scene owns a loop. The pipeline lives outside React; no per-frame re-render. | Verified |
| 4 | **Sources and controls** | The shared `SourcePicker` and `Transport` (`components/pipeline/Controls`) are reused unchanged. `AudioPipelineProvider` starts the loop and clears the source on unmount. | Verified |
| 5 | **Reduced motion** | Read live from `matchMedia('(prefers-reduced-motion: reduce)')` (host listens for changes) or by the scene's own query. The scene passes a `reduced` flag into its mapping every frame. | Verified for the host; not demonstrated for other scenes |
| 6 | **Silence** | `calm = !isPlaying || rms < 0.04`. Calm gives a dim, slowly moving rest state, no pulses. Same constant as Squall, held locally. | Verified |

## 3. The mapping layers (reusable pattern, scene-specific content)

| # | Layer | Pattern in Accretion | Reuse |
|---|---|---|---|
| 7 | **Pure params** (`accretion/params.ts`) | `toXParams(frame, reduced) -> flat object of bounded numbers`. Pure, no state, no clock, no DOM. Motion gating: `calm` and `reduced` multiply motion; jets and flares are removed when calm or reduced; colour and glow are not gated. 31 unit tests. | Verified. **Copy the shape, not the fields.** |
| 8 | **Stateful animator** (`accretion/animator.ts`) | `stepXAnim(state, params, dt, reduced)` mutates one preallocated object. Envelopes via the shared `follow` (attack 0.08 s, release 0.4 s; 0.35 s attack when reduced), accumulated phase and flow time (so speed changes bend rather than jump), impulse with exponential decay (`jet`), rate limiter (`flare`, 0.35 s minimum gap), `dt` clamped to 0.05 s, deterministic. 22 unit tests. | Verified. Time-dependent behaviour belongs here, never in params or the scene. |
| 9 | **Scene object** (`accretion/scene.ts`) | A class with `scene`, `camera`, `update(anim, view)` (writes uniforms and transforms, allocates nothing), `setViewport(w, h, pr)`, `releaseGpu()`, `dispose()`, `resourceCounts`, and module counters `sceneStats {created, disposed}`. Geometries and materials are registered through `own()` / `ownMat()` so disposal is complete. | Verified. The `own/ownMat` + counters idea is the reusable part. |
| 10 | **Canvas component** (`AccretionCanvas.tsx`) | Creates the host in an effect and disposes it in cleanup; draws inside one `useAudioFrame`: params, animator, resize check, `scene.update`, `host.render`. Exposes an optional `debugRef` with frame timing and the last params (read-only diagnostics). | Verified |
| 11 | **Experience component** (`Accretion.tsx`) | `AudioPipelineProvider` + `SourcePicker` + `Transport` + canvas, `data-scene` attribute, accessible title. | Verified |

## 4. The rendering host (reusable for Three.js scenes only)

`GlHost` (`lib/gl/host.ts`) plus pure rules in `lib/gl/state.ts`. A Canvas 2D scene does not need it.

| # | Concern | Behaviour | Status |
|---|---|---|---|
| 12 | **Lifecycle state** | Pure reducer `reduceGl`: `disposed` (absorbing), `unsupported`, `lost`, `hidden`, `inactive`. `drawable(state)` gates drawing; `render()` returns false when not drawable. `describeGl` names the status. 20 unit tests. | Verified |
| 13 | **Resize, DPR** | `ResizeObserver` on the canvas plus window `resize`; the DPR is also re-checked on every `render()` (a monitor change fires no resize). Ratio clamped to [0.5, 1.5] (`maxPixelRatio` option). The canvas is absolutely positioned so its size follows the container, never the reverse (prevents a growth feedback loop). Work is skipped when nothing changed. | Verified |
| 14 | **Visibility** | `visibilitychange` sets `hidden`; a host created while the page is hidden starts hidden (a defect found and fixed during Accretion). `setActive(false)` marks it inactive for another visualizer. | Verified |
| 15 | **Context loss** | `webglcontextlost` is `preventDefault`ed, state becomes `lost`, nothing draws; `webglcontextrestored` clears it, refits and calls the optional `onRestored`. Accretion's canvas calls `scene.releaseGpu()` when status becomes `lost` (so records of the old context are dropped and Three.js re-uploads on the next draw). Browser-verified with `WEBGL_lose_context` (simulated; no real GPU reset). | Verified (simulated) |
| 16 | **Unsupported WebGL** | Renderer constructor failure sets `unsupported` and the component shows a text message. Present in code; **not exercised in a browser**. | In code; not exercised in a browser |
| 17 | **Disposal** | `dispose()` removes every listener and observer, disposes the renderer, forces context loss, counts in `hostStats`. Idempotent. A scene disposes its own geometries and materials. 30 mount/unmount cycles and 50 host cycles ran clean. | Verified |
| 18 | **Reduced motion in the host** | `host.reducedMotion` mirrors the media query live. The host adds no motion itself. | Verified |

## 5. Testing and verification pattern

| # | Layer | How | Status |
|---|---|---|---|
| 19 | **Unit (Node)** | `node --import ./tests/resolve-ts.mjs --experimental-transform-types --test tests/<file>.test.ts`. Pure params, animator, host state, scene resource ownership (the host's ownership tests were checked against two deliberate mutants). The whole browser-kit suite is 263 tests. `tsc --noEmit -p tsconfig.json` is clean. | Verified |
| 20 | **Browser acceptance** | `preview/<name>-check.mjs` over Chrome DevTools Protocol, using `preview/cdp-lib-gpu.mjs` (GPU-enabled Edge; the shared `cdp-lib.mjs` forces `--disable-gpu` and is left unchanged). Sections: audio response and silence, reduced motion, resize, context loss and restore, mount cycles, hidden start. | Verified (Accretion 53/53) |
| 21 | **Read-only diagnostics** | The preview entry exposes `window.__<name>` with pixel sampling, synchronous GPU timing, frame-interval statistics and memory counts. | Verified |
| 22 | **Evidence pack** | Screenshots per state at several viewports, plus per-frame series. The Accretion review found problems stills alone would have missed (framing, banding, portrait clipping), see section 7. | Verified |

## 6. Integration, size and performance

| # | Item | Facts | Status |
|---|---|---|---|
| 23 | **Preview** | `preview/<name>-entry.tsx` (owns the pipeline so a script can drive it), `<name>.html`, served by `preview/serve-gl.mjs` (its own routes; shared `serve.mjs` untouched). esbuild: `--bundle --minify --jsx=automatic --alias:@=./src --define:process.env.NODE_ENV="production"`. A fresh build matched the shipped bundle byte for byte. | Verified |
| 24 | **App route** | `src/app/lab/<name>/page.tsx` renders the experience component. These are route files for a Next.js host app. This repository ships standalone esbuild previews instead, so the routes are type-checked but have not been built inside a Next.js app. | Type-checked only |
| 25 | **Size** | Accretion page 220,955 B gzip (budget 300 KB); Three.js `WebGLRenderer` alone about 131.6 KB gzip; the scene's own code about 8 KB gzip; Squall page 93.7 KB gzip. Each new Three.js scene shares that Three cost only if bundled into the same page, so budget it per route. | Verified |
| 26 | **Frame cost** | Intel UHD, headless Edge, DPR 1, 1248x563 and similar: interval median 16.7 ms (display-capped), main thread about 0.4 ms, synchronized GPU 4.0 ms (1248x410) to 7.5 ms (1248x716); full-HD canvas not measured. | Verified (limited) |
| 27 | **Quality governor** | Not implemented: reduced-resolution rendering was not needed on the hardware tested. The host exposes `maxPixelRatio` as the only knob. | Not implemented |

## 7. Design lessons, for new scenes

1. **Frame the default view deliberately.** Check the default camera at four viewports (1280x720, 1920x1080, 768x1024, 390x844) before calling it done; the first Accretion default hid its best structure.
2. **Do not cap the canvas width by accident.** The harness layout limited the canvas to 1248 px.
3. **Dither dark gradients** (atmospheres, vignettes) or the 8-bit contours show as boundaries.
4. **Taper additive particle columns** at their origin so they read as emitted rather than overlaid.
5. **Avoid geometric outlines** (a uniform thin ring); vary intensity and width around the shape.
6. **Record a short video or per-frame luminance series** for any claim about smoothness; stills cannot support it.
7. **Re-apply the clear colour in `onRestored`.** Found while building Constellation Core: Three.js rebuilds its background state on a context restore, so `setClearColor` is forgotten and the canvas background reverts to pure black (measured: `[2,4,12]` became `[0,0,0]`). Pass `onRestored: () => host.three?.setClearColor(...)` to `GlHost` (the hook already exists) and check a corner pixel before and after a restore. Accretion has the same latent behaviour (`[2,3,8]` became `[0,0,0]`, imperceptible) and was left unchanged.
8. **Judge audio response on the scene's own light, not the whole-frame mean**, which is diluted by the constant clear colour (first Constellation Core run: raw ratio 1.45x against a 1.5x gate, scene-only about 3.6x).
9. **Make each acceptance check labelled by input mode** (silent, scripted synthetic, demo, real). Never describe synthetic input as music.

## 8. What is Accretion-specific (do not copy)

`DISK_*`, `JET_*`, `STAR_*`, the disk, ring, halo, jet and star shaders, the orbiting camera constants, the flare angle (golden angle) and the field names of `AccretionParams` / `AccretionAnim`. Every visual constant in them was tuned on a synthetic signal.

## 9. Canvas 2D and custom-shader scenes

- A **Canvas 2D** scene (like Squall) uses sections 2, 3 and 5; it skips `GlHost`. It must still draw inside `useAudioFrame`, honour `reduced` and silence, clean up its own listeners, and recover from a resized canvas. A lifecycle reducer like `state.ts` could be reused for hidden/inactive handling (not demonstrated).
- A **fragment-shader-only** scene is still a Three.js scene in this codebase (a full-screen quad on `GlHost`); it needs the same disposal discipline and a measured GPU budget (proposed).
- Whichever technology is used, the **contract and the two mapping layers stay the same**.

## 10. Known limitations

Real music, headed browsers, other GPUs, a full 1920x1080 canvas, formal flash analysis, an intermittent browser-check stall seen once (not reproduced), the Next route, the unsupported-WebGL path in a browser, and context loss in a non-silent state.
