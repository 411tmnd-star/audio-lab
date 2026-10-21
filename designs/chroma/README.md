# Chroma Field: music as drifting colour

A volumetric field of drifting particle density and billowing, ink-like colour in a dark void. There is no object: bass swells and
thickens the cloud (and briefly compresses it on a bass hit), mids drive the swirl and the drift direction, highs add fine shimmer and
disperse the colour, and each detected onset (not a beat grid) sends a dispersion burst expanding through the volume. Deep cosmic
indigo, teal, magenta and pink on black. The camera is a slow dolly path; there is no post-processing, no mesh, no line and no
node network. The two references (a particle cloud and ink in water) are synthesised as two point-sprite layers: a few large soft
"ink" sprites and many tiny "dust" sprites.

The governing specification, the contract and its owner revision, decisions and verification record are in
[docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md](../../docs/visual-systems/411-AUDIOLAB-VISUAL-SYSTEMS.md) (sections 10.2 and 12).
Status: **baseline implemented; automated and browser verified except frame pacing (inconclusive, see section 12); human visual acceptance pending.**

## How it works

Each particle has a fixed home position (drawn once from a seeded PRNG through a ridged-noise density that gathers particles into
filaments and masses with real voids, and is lowered near the centre so there is no core) and a fixed register (bass, mid or high).
On the GPU a particle is its home displaced by a divergence-free curl field whose phase the animator accumulates (the mid band sets
its speed and its drift direction turns with it), scaled by the bass, and pushed by recent onset bursts (thin shells expanding from
deterministic origins). Each register is its own population: its visible fraction follows its own band, and it owns a band of the
palette. `rmsEnergy` changes exposure only. Chroma has no history: its state (visual clock, flow phase, smoothed envelopes, a bounded
ring of 8 onsets) lives in the animator, advances only while playing, and is cleared by a source change.

## Code

`web_kit/src/lib/chroma/`: `field.ts` (cloud generation, flow, burst shell, camera path), `params.ts`, `animator.ts` (state),
`scene.ts` (two point layers), `shaders.ts`. `web_kit/src/components/chroma/` (`Chroma.tsx`, `ChromaCanvas.tsx`),
`web_kit/src/app/lab/chroma/page.tsx`, `web_kit/tests/chroma-{field,anim,scene}.test.ts`, `web_kit/preview/chroma-{entry.tsx,check.mjs}`
and `chroma.html`.

## Preview

From `web_kit/`:

```
node preview/build.mjs chroma
node preview/serve-gl.mjs 5359
```

Open `http://localhost:5359/chroma`. Add `?source=pattern` for a scripted 120 BPM synthetic pattern, `?source=demo` for the synthetic demo,
`?source=song:detty` for the Detty offline song (real analysed features on a silent clock; **no audio ships**), `?quality=lite` for about
40% of the particles. Or pick a source with the on-page controls. If the port is busy, pass another and set `CHROMA_PORT` for the checks.
Browser checks: `node preview/chroma-check.mjs` (headless Edge, real GPU; screenshots and a JSON report go to `scratch_shots/chroma/`; a
copy of the report is in `evidence/`). The real Next.js route `src/app/lab/chroma/page.tsx` type-checks but was **not run**.
