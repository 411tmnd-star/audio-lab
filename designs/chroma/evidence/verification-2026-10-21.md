# Chroma Field: verification record, 2026-10-21

Full record, labels, limitations and the human checklist: [docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md](../../../docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md) section 12.
Machine: Intel UHD 0x9B41, ANGLE D3D11, WebGL 2.0, headless Edge. **The laptop ran on battery (12% down to 1%) and Edge was throttled to 30 Hz**
(a Terrain control read 33.3 ms in the same session). Detty is a silent clock: features only, nothing was heard.

| Command (from `web_kit/`) | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npm test` | 476 tests, 476 pass, 0 fail (436 before Chroma; Chroma adds 40) |
| `node preview/build.mjs chroma`, `node preview/serve-gl.mjs 5359`, `CHROMA_PORT=5359 node preview/chroma-check.mjs` | 41 checks: 38 pass, **1 fail** (synchronous GPU median 5.4 ms against a 5 ms bound), **2 inconclusive** (frame pacing, throttled); exit code 2. Report: `chroma-check-report-2026-10-21.json` (its `moved` list records every threshold, metric and design change made after measuring) |
| Matrix, Core, Resonator, Score, Terrain browser checks | **not re-run** (battery); unchanged; last results stand |
| `python -m pytest` | not run (pytest not installed; no Python change) |

Not verified: frame pacing; GPU time under normal power; audible Detty; the Next route; the `GlHost` StrictMode defect; human acceptance.
Screenshots in `../screenshots/` are static frames; `montage-name-blind.png` shows Matrix, Chroma, Core (top) and Resonator, Terrain, Score (bottom).
