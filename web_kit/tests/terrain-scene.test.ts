import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";

import { MAX_DT_S, SNAP_S, createTerrainAnim, stepTerrainAnim } from "../src/lib/terrain/animator";
import { COLS, ROWS, WAVE_SLOTS } from "../src/lib/terrain/field";
import { TEX_W, TerrainHistory } from "../src/lib/terrain/history";
import { REST_ILLUMINATION, SILENCE_RMS, toTerrainParams } from "../src/lib/terrain/params";
import { TerrainScene, sceneStats } from "../src/lib/terrain/scene";
import { TERRAIN_FRAG, TERRAIN_VERT } from "../src/lib/terrain/shaders";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

// Three.js builds scenes, geometry and materials without a GPU, so structure, ownership, disposal, framing and upload behaviour
// are tested here. Shader compilation and drawing are checked in the browser (preview/terrain-check.mjs).

const fr = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, rmsEnergy: 0.5, bass: 0.5, mid: 0.4, high: 0.3, ...o });
const P = toTerrainParams(fr(), false);

describe("Terrain params: loudness is lighting only", () => {
  it("maps rmsEnergy to illumination with a floor and no height", () => {
    assert.equal(toTerrainParams(fr({ rmsEnergy: 0 }), false).illumination, REST_ILLUMINATION);
    assert.equal(toTerrainParams(fr({ rmsEnergy: 1 }), false).illumination, 1);
    const mid = toTerrainParams(fr({ rmsEnergy: 0.5 }), false).illumination;
    assert.ok(mid > REST_ILLUMINATION && mid < 1);
    assert.deepEqual(Object.keys(toTerrainParams(fr(), false)).sort(), ["calm", "illumination", "playing", "reduced"]);
  });
  it("flags silence, a stopped source and reduced motion", () => {
    assert.equal(toTerrainParams(fr({ rmsEnergy: SILENCE_RMS / 2 }), false).calm, true);
    assert.equal(toTerrainParams(fr({ isPlaying: false, rmsEnergy: 0.8 }), false).calm, true);
    assert.equal(toTerrainParams(fr(), true).reduced, true);
  });
  it("does not mutate the frame and survives non-finite loudness", () => {
    const f = fr();
    toTerrainParams(f, false);
    assert.ok(Object.isFrozen(f));
    assert.ok(Number.isFinite(toTerrainParams({ ...f, rmsEnergy: NaN } as AudioFeatureFrame, false).illumination));
  });
});

describe("Terrain animator: the displayed clock", () => {
  const DT = 1 / 60;
  it("follows the playhead without drift over a long run and never runs backwards on a coarse clock", () => {
    const a = createTerrainAnim();
    let t = 0, prev = 0;
    for (let i = 0; i < 36_000; i++) {
      t += DT;
      stepTerrainAnim(a, P, Math.floor(t / 0.05) * 0.05, DT); // a source clock that moves in 50 ms steps
      assert.ok(a.now >= prev);
      prev = a.now;
    }
    assert.ok(Math.abs(a.now - t) < 0.08, `error ${a.now - t}`);
  });
  it("holds the playhead exactly while paused and resumes without a jump", () => {
    const a = createTerrainAnim();
    stepTerrainAnim(a, P, 5, DT); // the first frame snaps from 0 to the playhead
    const snapsAtStart = a.snaps;
    const paused = toTerrainParams(fr({ isPlaying: false }), false);
    for (let i = 0; i < 100; i++) stepTerrainAnim(a, paused, 5.2, DT);
    assert.equal(a.now, 5.2);
    const before = a.now;
    stepTerrainAnim(a, P, 5.2, DT);
    assert.ok(Math.abs(a.now - before) < 0.05);
    assert.equal(a.snaps, snapsAtStart, "neither the pause nor the resume snapped");
  });
  it("snaps on a seek and ignores invalid input; a stalled tab cannot cause a jump", () => {
    const a = createTerrainAnim();
    stepTerrainAnim(a, P, 10, DT);
    stepTerrainAnim(a, P, 60, DT);
    assert.equal(a.now, 60);
    assert.equal(a.snaps, 2);
    const snap = { ...a };
    stepTerrainAnim(a, P, NaN, DT);
    stepTerrainAnim(a, P, -1, DT);
    assert.deepEqual({ ...a }, snap);
    const b = createTerrainAnim();
    stepTerrainAnim(b, P, 0.1, 5);
    assert.ok(b.now <= MAX_DT_S + 0.11 && SNAP_S > 0);
  });
  it("updates in place and returns the same object", () => {
    const a = createTerrainAnim();
    assert.equal(stepTerrainAnim(a, P, 1, DT), a);
    assert.ok(a.illumination >= 0 && a.illumination <= 1);
  });
});

describe("Terrain scene: identity and composition", () => {
  it("is one connected mesh: a COLS x ROWS grid with a static index, no separate objects", () => {
    const s = new TerrainScene();
    assert.equal(s.scene.children.length, 1);
    const g = s.geometry;
    assert.equal(g.getAttribute("position").count, COLS * ROWS);
    assert.equal(g.getAttribute("aRC").count, COLS * ROWS);
    assert.equal(g.index!.count, (COLS - 1) * (ROWS - 1) * 6);
    // every triangle joins vertices of adjacent rows/columns only (a continuous surface, no free-floating pieces)
    const idx = g.index!.array as Uint32Array;
    for (let i = 0; i < idx.length; i += 3) {
      const rs = [0, 1, 2].map((k) => Math.floor(idx[i + k] / COLS)), cs = [0, 1, 2].map((k) => idx[i + k] % COLS);
      assert.ok(Math.max(...rs) - Math.min(...rs) <= 1 && Math.max(...cs) - Math.min(...cs) <= 1);
    }
    s.dispose();
  });

  it("every vertex is used by the surface (no orphan vertices) and the surface is closed over the grid", () => {
    const s = new TerrainScene();
    const used = new Uint8Array(COLS * ROWS);
    for (const v of s.geometry.index!.array as Uint32Array) used[v] = 1;
    assert.ok(used.every((v) => v === 1));
    s.dispose();
  });

  it("the shader declares its inputs and the surface does not need decoration to be drawn", () => {
    for (const n of ["aRC", "uRows", "uHead", "uNow", "uShockT", "uShockS"]) assert.ok(TERRAIN_VERT.includes(n), n);
    assert.ok(TERRAIN_FRAG.includes("uDecor") && TERRAIN_FRAG.includes("dFdx"));
    assert.ok(/gl_FragColor/.test(TERRAIN_FRAG));
    // no lights, no post-processing: the surface is a single ShaderMaterial mesh
    const s = new TerrainScene();
    const lights: THREE.Object3D[] = [];
    s.scene.traverse((o) => { if ((o as THREE.Light).isLight) lights.push(o); });
    assert.equal(lights.length, 0);
    assert.ok(s.mesh.material instanceof THREE.ShaderMaterial);
    s.dispose();
  });

  it("decor off switches off everything but the surface", () => {
    const on = new TerrainScene(), off = new TerrainScene({ decor: false });
    assert.equal(on.uniforms.uDecor.value, 1);
    assert.equal(off.uniforms.uDecor.value, 0);
    on.dispose(); off.dispose();
  });

  it("the camera is fixed: its position depends on the viewport only, never on the audio", () => {
    const s = new TerrainScene();
    s.setViewport(1280, 720, 1);
    const p0 = s.camera.position.clone();
    const h = new TerrainHistory(), a = createTerrainAnim();
    for (let i = 0; i < 600; i++) {
      const f = fr({ time: i / 60, bass: (i % 13) / 13, beatDetected: i % 20 === 0, rmsEnergy: (i % 7) / 7 });
      h.push(f);
      stepTerrainAnim(a, toTerrainParams(f, false), f.time, 1 / 60);
      s.update(h, a, toTerrainParams(f, false));
    }
    assert.deepEqual(s.camera.position.toArray(), p0.toArray());
    s.dispose();
  });

  it("framing keeps the near edge's full width in view at wide, 16:9 and portrait aspects", () => {
    const s = new TerrainScene();
    for (const [w, h] of [[2000, 600], [1280, 720], [390, 800]]) {
      s.setViewport(w, h, 1);
      s.camera.updateMatrixWorld();
      for (const x of [-9, 9]) {
        const p = new THREE.Vector3(x, 0, 0).project(s.camera);
        assert.ok(Math.abs(p.x) < 1, `x=${x} at ${w}x${h} projects to ${p.x.toFixed(2)}`);
      }
    }
    s.dispose();
  });

  it("looks down at the land: the eye is above the surface and the far edge is farther than the near edge", () => {
    const s = new TerrainScene();
    s.setViewport(1280, 720, 1);
    assert.ok(s.camera.position.y > 5);
    assert.ok(s.camera.position.z > 0);
    s.dispose();
  });
});

describe("Terrain scene: updates, uploads and lifecycle", () => {
  it("shares the history's array with the texture (no copy) and uploads only when a row was written", () => {
    const s = new TerrainScene(), h = new TerrainHistory(), a = createTerrainAnim();
    s.update(h, a, P);
    assert.equal(s.texture.image.data, h.data);
    assert.equal(s.texture.image.width, TEX_W);
    assert.equal(s.texture.image.height, ROWS);
    const u0 = s.uploads;
    for (let i = 0; i < 5; i++) s.update(h, a, P);
    assert.equal(s.uploads, u0, "no row written, no upload");
    h.push(fr({ time: 1 }));
    s.update(h, a, P);
    assert.equal(s.uploads, u0 + 1);
    h.push(fr({ time: 1.01 })); // skipped: step not elapsed
    s.update(h, a, P);
    assert.equal(s.uploads, u0 + 1);
    s.dispose();
  });

  it("writes the clock, head and illumination to uniforms; reduced motion turns the shockwave off", () => {
    const s = new TerrainScene(), h = new TerrainHistory(), a = createTerrainAnim();
    for (let i = 0; i < 30; i++) h.push(fr({ time: i / 20 }));
    a.now = 1.4; a.illumination = 0.6;
    s.update(h, a, P);
    assert.equal(s.uniforms.uNow.value, 1.4);
    assert.equal(s.uniforms.uHead.value, h.headSlot);
    assert.equal(s.uniforms.uIllum.value, 0.6);
    assert.equal(s.uniforms.uWave.value, 1);
    s.update(h, a, { ...P, reduced: true });
    assert.equal(s.uniforms.uWave.value, 0);
    s.dispose();
  });

  it("hands the newest onsets still inside the wave's life to the shader, newest first, and empties the rest", () => {
    const s = new TerrainScene(), h = new TerrainHistory(), a = createTerrainAnim();
    for (const [t, st] of [[1.0, 0.4], [1.5, 0.6], [2.0, 0.9]] as const) {
      h.push(fr({ time: t, beatDetected: true, onsetStrength: st }));
      h.push(fr({ time: t + 0.1, beatDetected: false }));
    }
    a.now = 2.3;
    s.update(h, a, P);
    const T = s.uniforms.uShockT.value as Float32Array, S = s.uniforms.uShockS.value as Float32Array;
    assert.equal(T.length, WAVE_SLOTS);
    assert.ok(Math.abs(T[0] - 2.0) < 1e-6 && Math.abs(S[0] - 0.9) < 1e-6);
    assert.ok(Math.abs(T[1] - 1.5) < 1e-6);
    a.now = 20; // all expired
    s.update(h, a, P);
    for (let i = 0; i < WAVE_SLOTS; i++) assert.equal(S[i], 0);
    s.dispose();
  });

  it("a frame's update allocates no new GPU objects and keeps its resource counts", () => {
    const s = new TerrainScene(), h = new TerrainHistory(), a = createTerrainAnim();
    const before = JSON.stringify(s.resourceCounts);
    for (let i = 0; i < 300; i++) { h.push(fr({ time: i / 60 })); s.update(h, a, P); }
    assert.equal(JSON.stringify(s.resourceCounts), before);
    s.dispose();
  });

  it("dispose is idempotent, counted once, and update after dispose is a no-op", () => {
    const c0 = sceneStats.created, d0 = sceneStats.disposed;
    const s = new TerrainScene(), h = new TerrainHistory(), a = createTerrainAnim();
    let disposed = 0;
    s.geometry.addEventListener("dispose", () => disposed++);
    s.texture.addEventListener("dispose", () => disposed++);
    s.material.addEventListener("dispose", () => disposed++);
    s.dispose();
    s.dispose();
    assert.equal(disposed, 3, "geometry, texture and material each released once");
    assert.equal(sceneStats.created - c0, 1);
    assert.equal(sceneStats.disposed - d0, 1);
    assert.doesNotThrow(() => s.update(h, a, P));
    assert.equal(s.scene.children.length, 0);
  });

  it("releaseGpu keeps the scene and forces a re-upload on the next update", () => {
    const s = new TerrainScene(), h = new TerrainHistory(), a = createTerrainAnim();
    h.push(fr({ time: 1 }));
    s.update(h, a, P);
    const u = s.uploads;
    s.releaseGpu();
    assert.equal(s.scene.children.length, 1);
    s.update(h, a, P);
    assert.equal(s.uploads, u + 1);
    s.dispose();
  });
});
