import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { createChromaAnim, stepChromaAnim } from "../src/lib/chroma/animator";
import { BOUNDS, BURST_SLOTS, COUNTS } from "../src/lib/chroma/field";
import { toChromaParams } from "../src/lib/chroma/params";
import { ChromaScene, sceneStats } from "../src/lib/chroma/scene";
import { CHROMA_FRAG, CHROMA_VERT } from "../src/lib/chroma/shaders";
import { IDLE_FRAME, loadOfflineSource, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline";

// Three.js builds scenes, geometry and materials without a GPU, so structure, ownership, disposal, framing and uniform writes
// are tested here. Shader compilation and drawing are checked in the browser (preview/chroma-check.mjs).

const fr = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, rmsEnergy: 0.5, bass: 0.5, mid: 0.4, high: 0.3, ...o });
const P = toChromaParams(fr(), false);

describe("Chroma scene: identity and negative design, structurally", () => {
  it("is made only of point sprites: no mesh, no line, no segments, no light", () => {
    const s = new ChromaScene();
    const kinds: string[] = [];
    s.scene.traverse((o) => { if (o !== s.scene) kinds.push(o.constructor.name); });
    assert.deepEqual(kinds, ["Points", "Points"]);
    const bad: THREE.Object3D[] = [];
    s.scene.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Light) bad.push(o); });
    assert.equal(bad.length, 0);
    s.dispose();
  });
  it("has no index (no connectivity: no edges, no triangles, no node graph) and the counts asked for", () => {
    for (const q of ["full", "lite"] as const) {
      const s = new ChromaScene({ quality: q });
      for (const p of [s.ink, s.dust]) assert.equal(p.geometry.index, null);
      assert.equal(s.ink.geometry.getAttribute("position").count, COUNTS[q].ink);
      assert.equal(s.dust.geometry.getAttribute("position").count, COUNTS[q].dust);
      assert.equal(s.particleCount, COUNTS[q].ink + COUNTS[q].dust);
      s.dispose();
    }
    assert.ok(COUNTS.lite.dust < 0.5 * COUNTS.full.dust);
  });
  it("blends additively with no depth write and no post-processing: density reads as brightness", () => {
    const s = new ChromaScene();
    for (const p of [s.ink, s.dust]) {
      const m = p.material as THREE.ShaderMaterial;
      assert.equal(m.blending, THREE.AdditiveBlending);
      assert.equal(m.depthWrite, false);
      assert.equal(m.transparent, true);
    }
    s.dispose();
  });
  it("the shaders carry the palette (indigo, teal, magenta, pink), the curl flow and the burst shell, and no terrain/lane/bar vocabulary", () => {
    for (const w of ["INDIGO", "TEAL", "MAGENTA", "PINK", "curl(", "uBurstA", "uHigh", "uMid", "uBass"]) assert.ok(CHROMA_VERT.includes(w), w);
    assert.ok(/gl_PointSize/.test(CHROMA_VERT) && /gl_PointCoord/.test(CHROMA_FRAG));
    for (const w of ["heightfield", "uRows", "lane", "bar"]) assert.ok(!CHROMA_VERT.toLowerCase().includes(w.toLowerCase()), w);
  });
});

describe("Chroma scene: framing, camera and uniforms", () => {
  it("the camera follows the visual clock and nothing else: same clock, same view; reduced motion holds it", () => {
    const s = new ChromaScene(), a = createChromaAnim();
    s.setViewport(1280, 720, 1);
    a.clock = 37.2; s.update(a, P);
    const p1 = s.camera.position.toArray();
    a.bass = 1; a.mid = 1; a.high = 1; a.exposure = 1; s.update(a, P);
    assert.deepEqual(s.camera.position.toArray(), p1, "audio does not move the camera");
    a.clock = 90; s.update(a, P);
    assert.notDeepEqual(s.camera.position.toArray(), p1);
    s.update(a, { ...P, reduced: true });
    const r1 = s.camera.position.toArray();
    a.clock = 10; s.update(a, { ...P, reduced: true });
    assert.deepEqual(s.camera.position.toArray(), r1, "reduced motion: fixed camera");
    s.dispose();
  });
  it("the whole volume stays in view at wide, 16:9 and portrait aspects", () => {
    const s = new ChromaScene();
    for (const [w, h] of [[2000, 600], [1280, 720], [390, 800]]) {
      s.setViewport(w, h, 1);
      s.camera.updateMatrixWorld();
      for (const x of [-BOUNDS.x * 0.7, BOUNDS.x * 0.7]) {
        const p = new THREE.Vector3(x, 0, 0).project(s.camera);
        assert.ok(Math.abs(p.x) < 1, `x=${x} at ${w}x${h} projects to ${p.x.toFixed(2)}`);
      }
    }
    s.dispose();
  });
  it("writes the animation state into uniforms, bursts as ages (-1 when none) and origins with strength", () => {
    const s = new ChromaScene(), a = createChromaAnim();
    for (let i = 0; i < 60; i++) stepChromaAnim(a, toChromaParams(fr({ mid: 0.8, bassHit: 0.3 }), false), 1 / 60);
    stepChromaAnim(a, toChromaParams(fr({ beatDetected: true, onsetStrength: 0.9 }), false), 1 / 60);
    for (let i = 0; i < 10; i++) stepChromaAnim(a, toChromaParams(fr({ mid: 0.8 }), false), 1 / 60);
    s.update(a, P);
    const u = s.uniforms as Record<string, { value: number | Float32Array | THREE.Vector4[] | THREE.Vector3 }>;
    assert.equal(u.uMid.value, a.mid);
    assert.equal(u.uExposure.value, a.exposure);
    const ages = u.uBurstA.value as Float32Array;
    assert.equal(ages.length, BURST_SLOTS);
    assert.ok(ages[0] > 0 && ages[0] < 0.3);
    for (let k = 1; k < BURST_SLOTS; k++) assert.equal(ages[k], -1);
    assert.ok(Math.abs((u.uBurstO.value as THREE.Vector4[])[0].w - 0.9) < 1e-6);
    assert.deepEqual((u.uFlow.value as THREE.Vector3).toArray().map((v) => +v.toFixed(9)), a.flow.map((v) => +v.toFixed(9)));
    s.update(a, { ...P, reduced: true });
    assert.equal(u.uBurstOn.value, 0);
    assert.equal(u.uShimmerOn.value, 0);
    s.dispose();
  });
  it("a frame's update allocates no new GPU objects", () => {
    const s = new ChromaScene(), a = createChromaAnim();
    const before = JSON.stringify(s.resourceCounts);
    for (let i = 0; i < 300; i++) { stepChromaAnim(a, toChromaParams(fr({ beatDetected: i % 30 === 0, onsetStrength: 0.5 }), false), 1 / 60); s.update(a, P); }
    assert.equal(JSON.stringify(s.resourceCounts), before);
    s.dispose();
  });
  it("dispose is idempotent, counted once, releases both geometries and both materials; update after dispose is a no-op", () => {
    const c0 = sceneStats.created, d0 = sceneStats.disposed;
    const s = new ChromaScene(), a = createChromaAnim();
    let n = 0;
    for (const p of [s.ink, s.dust]) { p.geometry.addEventListener("dispose", () => n++); (p.material as THREE.Material).addEventListener("dispose", () => n++); }
    s.dispose(); s.dispose();
    assert.equal(n, 4);
    assert.equal(sceneStats.created - c0, 1); assert.equal(sceneStats.disposed - d0, 1);
    assert.doesNotThrow(() => s.update(a, P));
    assert.equal(s.scene.children.length, 0);
  });
  it("releaseGpu keeps the scene graph", () => {
    const s = new ChromaScene();
    s.releaseGpu();
    assert.equal(s.scene.children.length, 2);
    s.dispose();
  });
});

// REAL feature data: Detty's pre-computed analysis bundle through the application's own offline source, on a fake silent clock
// (Detty ships no audio: this verifies what the field is given, not what anyone hears).
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "public");
function serveFromDisk() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    try { return new Response(readFileSync(join(PUBLIC, String(url).replace(/^\//, ""))), { status: 200 }); }
    catch { return new Response("not found", { status: 404 }); }
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb); return s / (a.length * std(a) * std(b)); };

describe("Chroma on Detty's real feature data (silent clock, features only)", () => {
  it("the field is driven by real, different signals; every asserted onset edge becomes a burst; the flow moves", async () => {
    const restore = serveFromDisk();
    try {
      let ms = 0;
      const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId: "detty", now: () => ms });
      await src.play();
      const a = createChromaAnim();
      const bass: number[] = [], mid: number[] = [], high: number[] = [], flowD: number[] = [];
      let flagged = 0, prev = false, maxLive = 0;
      let last = [0, 0, 0];
      for (let i = 0; i < 100 * 60; i++) {
        const f = src.sample(ms / 1000);
        if (f.beatDetected && !prev && f.isPlaying) flagged++;
        prev = f.beatDetected;
        stepChromaAnim(a, toChromaParams(f, false), 1 / 60);
        bass.push(a.bass); mid.push(a.mid); high.push(a.high);
        if (i % 60 === 59) { flowD.push(Math.hypot(a.flow[0] - last[0], a.flow[1] - last[1], a.flow[2] - last[2])); last = [...a.flow]; }
        maxLive = Math.max(maxLive, a.bursts);
        ms += 1000 / 60;
      }
      src.dispose();
      assert.ok(flagged > 40, `${flagged} onsets in 100 s`);
      assert.equal(a.onsets, flagged, "every asserted onset edge is a burst; none invented");
      assert.equal(maxLive, BURST_SLOTS);
      assert.ok(std(bass) > 0.1 && std(mid) > 0.05, `bass std ${std(bass).toFixed(3)}, mid std ${std(mid).toFixed(3)}`);
      assert.ok(Math.abs(corr(bass, mid)) < 0.95 && Math.abs(corr(bass, high)) < 0.95 && Math.abs(corr(mid, high)) < 0.95, "the three bands are not the same signal");
      assert.ok(Math.min(...flowD) > 0, "the flow moves every second");
      assert.ok(std(flowD) > 0.003, "and its speed follows the music (not constant)");
    } finally {
      restore();
    }
  });
});
