# Score: verification evidence (2026-10-21)

The verification record, with its status table, decisions and limitations, is section 7.7 of
[docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md](../../../docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md). This folder holds the raw output.

- `score-check-report-2026-10-21.json`: results and measurements from the last complete `node preview/score-check.mjs` run
  (50 checks: 40 SYNTHETIC, 10 DETTY, all passed). Detty ran on its silent clock: features only, nothing was heard.
- Machine: Intel UHD Graphics 0x9B41, Direct3D11, headless Edge, one machine.
- Commands run from `web_kit/`: `npx tsc --noEmit -p .` (exit 0); `npm test` (368 pass, 0 fail); `node preview/build.mjs score`;
  `node preview/serve-gl.mjs 5355` (5354 was held by an older server not started by this task); `SCORE_PORT=5355 node preview/score-check.mjs`.
- Not run: `python -m pytest`, `matrix-check.mjs`, `core-check.mjs`, `resonator-check.mjs` (no Python or existing-scene change).
- Performance varies run to run; the JSON holds the final run only. The specification records the range over six runs.
