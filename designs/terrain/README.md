# Terrain with Memory: the music becomes land

A continuous three-dimensional heightfield built from the audio. Bass raises broad amber ridges down the middle of the land, mids roll
cyan valleys across its width, highs add fine violet micro-crests. New relief appears at the **near** edge and recedes along Z, so the
landscape keeps the shape of what was played: a bass swell heard six seconds ago is still a ridge, six seconds farther away.
A detected onset (not a beat grid) leaves a thin crease in the land and sends a ripple through it that outruns the terrain.
The camera is fixed; the recession is the only motion. No post-processing, no particles, no lights.

The governing specification, the six-point contract, decisions and verification record are in
[docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md](../../docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md) (sections 10 and 11).
Status: **baseline implemented and automated/browser verified; human visual acceptance pending.**

## How the memory works

The land is a bounded ring of **rows**. A row is a lateral cross-section of the land at one instant of the playhead. It is computed
once, when the sample is recorded (`field.ts`), and stored; the shader only displaces a static mesh by the stored heights and places
each row on Z by its own recorded time (`z = -age * 1.6`). Nothing about a stored row changes afterwards, so loudness or new
music cannot rewrite the past. `rmsEnergy` therefore lights the contour lines and never moves a vertex.

Frames carry no sequence number, so (as in Score) the record is keyed to the playhead: a row is appended only when the playhead has
advanced 50 ms (longer than twice the 23.2 ms analysis hop); a repeated frame object is ignored; nothing is written while paused;
a forward jump over 0.5 s is **not bridged**, two flat void rows bracket the unrecorded span and the shader dims it; a rewind over 50 ms
or a new source clears the record; onsets are edge-detected on every frame, kept for the shockwave, and the strongest one since the
last row is deposited in the next row as its scar. Storage is one fixed 160-row ring (about 8 s) held in the float texture the shader reads.

## Code

`web_kit/src/lib/terrain/`: `field.ts` (the land rule, time-to-distance, shockwave), `history.ts` (the ring and its policies),
`params.ts` (loudness to lighting), `animator.ts` (displayed clock), `scene.ts` (one mesh, one material, one data texture),
`shaders.ts`. `web_kit/src/components/terrain/` (`Terrain.tsx`, `TerrainCanvas.tsx`), `web_kit/src/app/lab/terrain/page.tsx`,
`web_kit/tests/terrain-{history,field,scene,detty}.test.ts`, `web_kit/preview/terrain-{entry.tsx,check.mjs}` and `terrain.html`.

## Preview

From `web_kit/`:

```
node preview/build.mjs terrain
node preview/serve-gl.mjs 5358
```

Open `http://localhost:5358/terrain`. Add `?source=pattern` for a scripted 120 BPM synthetic pattern, `?source=demo` for the synthetic demo,
`?source=song:detty` for the Detty offline song (real analysed features on a silent clock; **no audio ships**), `?decor=0` to remove the
contours, tints, edge line, horizon fade and shockwave and leave only the shaded surface. Or pick a source with the on-page controls.
If the port is busy, pass another and set `TERRAIN_PORT` for the checks. Browser checks: `node preview/terrain-check.mjs`
(headless Edge, real GPU; screenshots and a JSON report go to `scratch_shots/terrain/`; a copy of the report is in `evidence/`).
The real Next.js route `src/app/lab/terrain/page.tsx` type-checks but was **not run** (there is no Next host in this repository).
