# Terrain with Memory: verification record, 2026-10-21

The full record, labels, limitations and the human acceptance checklist are in
[docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md](../../../docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md) section 11. This file lists
what was run. Machine: Intel UHD Graphics 0x9B41, ANGLE D3D11, WebGL 2.0, headless Edge, Windows 11, one machine. Detty is a silent clock:
its pre-analysed features were played, nothing was heard.

| Command (from `web_kit/` unless noted) | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npm test` | 436 tests, 102 suites, 436 pass, 0 fail (368 before Terrain; Terrain adds 68: history 26, field 16, scene/animator/params 20, Detty feature data 6) |
| `node preview/build.mjs terrain` | built |
| `node preview/serve-gl.mjs 5358`, then `TERRAIN_PORT=5358 node preview/terrain-check.mjs` | **52/52** (SYNTHETIC 44/44, DETTY 8/8); report: `terrain-check-report-2026-10-21.json`; first run 47/52, second 51/52, see the `moved` list in the report and section 11.7 |
| `node preview/matrix-check.mjs <dir>` (server on 5354, hard-coded) | 60/60 |
| `node preview/core-check.mjs <dir>` (server on 5354) | 70/70 |
| `node preview/resonator-check.mjs <dir>` (server on 5354) | 46/46 on the second run; first run 45/46, failing check not captured, not reproduced |
| `SCORE_PORT=5354 node preview/score-check.mjs <dir>` | 50/50 |
| `python -m pytest` (repo root) | **not run**: pytest is not installed in the active Python; no Python change |

Not verified: audible Detty; the Next.js route `/lab/terrain` (no Next host); the `GlHost` StrictMode first-mount defect for Terrain (deferred
by the owner; inferred to apply, not observed); human visual acceptance.

Screenshots in `../screenshots/` are static frames from the final run. The unlabelled comparison is `montage-name-blind.png` (top row Matrix,
Terrain, Core; bottom row Resonator, Score, Terrain with decoration off).
