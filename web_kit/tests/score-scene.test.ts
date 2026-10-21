import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";

import { createScoreAnim } from "../src/lib/score/animator";
import { HISTORY_CAPACITY, MARKER_CAPACITY, ScoreHistory } from "../src/lib/score/history";
import { toScoreParams } from "../src/lib/score/params";
import { GRID_N, LANES, LANE_H, LANE_HEX, LEFT_X, NOW_X, UNITS_PER_S, ScoreScene, sceneStats } from "../src/lib/score/scene";
import { IDLE_FRAME, makeFrame, type AudioFeatureFrame } from "../src/lib/pipeline/contract";

// Three.js builds scenes, geometry and materials without a GPU, so structure, ownership, disposal, framing and buffer updates
// are tested here. Shader compilation and drawing are checked in the browser (preview/score-check.mjs).

const fr = (o: Partial<AudioFeatureFrame> = {}) => makeFrame({ ...IDLE_FRAME, isPlaying: true, rmsEnergy: 0.5, bass: 0.5, mid: 0.4, high: 0.3, ...o });
const P = toScoreParams(fr(), false);

function collect(s: ScoreScene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  s.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geometries.add(m.geometry);
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => materials.add(x));
  });
  return { geometries: [...geometries], materials: [...materials] };
}

describe("Score scene: identity and composition", () => {
  it("has exactly three lanes, top to bottom high, mid, bass, in the specified colours", () => {
    assert.deepEqual(LANE_HEX, { bass: "#FF9900", mid: "#00F0FF", high: "#9D00FF" });
    assert.deepEqual(LANES.map((l) => l.id), ["high", "mid", "bass"]);
    assert.ok(LANES[0].y > LANES[1].y && LANES[1].y > LANES[2].y);
    const s = new ScoreScene();
    assert.equal(s.lanes.length, 3);
    const rgb = s.lanes.map((m) => ((m.material as THREE.ShaderMaterial).uniforms.uColour.value as THREE.Vector3).toArray().map((v) => Math.round(v * 255)));
    assert.deepEqual(rgb, [[0x9d, 0x00, 0xff], [0x00, 0xf0, 0xff], [0xff, 0x99, 0x00]]);
    s.dispose();
  });

  it("the lane stack is shallow: a small depth range, much smaller than its width", () => {
    const zs = LANES.map((l) => l.z);
    assert.ok(Math.max(...zs) - Math.min(...zs) < 3);
    assert.ok(Math.max(...zs) - Math.min(...zs) > 0);
  });

  it("negative design: no instanced columns, spheres, tori or node graphs, and no particles", () => {
    const s = new ScoreScene();
    s.scene.traverse((o) => {
      assert.ok(!(o as THREE.InstancedMesh).isInstancedMesh, "no instanced geometry (bar columns, beads)");
      const g = (o as THREE.Mesh).geometry;
      if (g) assert.ok(!["SphereGeometry", "TorusGeometry", "RingGeometry", "IcosahedronGeometry", "BoxGeometry"].includes(g.type), g.type);
      assert.ok(!(o as THREE.Light).isLight);
    });
    // The only Points object is the marker head (one per onset marker), never a decorative field.
    const pts = s.scene.getObjectsByProperty("isPoints", true) as THREE.Points[];
    assert.equal(pts.length, 1);
    assert.equal(pts[0].geometry.getAttribute("aT").count, MARKER_CAPACITY * 2);
    s.dispose();
  });

  it("decor: false removes only the plates; lanes, grid, rules, markers and the boundary remain", () => {
    const withDecor = new ScoreScene();
    const without = new ScoreScene({ decor: false });
    assert.equal(withDecor.plates.length, 3);
    assert.equal(without.plates.length, 0);
    assert.equal(without.lanes.length, 3);
    assert.equal(without.scene.children.length, withDecor.scene.children.length - 3);
    withDecor.dispose();
    without.dispose();
  });

  it("the time grid has one line per whole second of the window, plus a margin", () => {
    const s = new ScoreScene();
    const grid = s.scene.children.find((c) => (c as THREE.LineSegments).isLineSegments && (c as THREE.LineSegments).geometry.getAttribute("aK")) as THREE.LineSegments;
    assert.equal(grid.geometry.getAttribute("aK").count, GRID_N * 2);
    s.dispose();
  });
});

describe("Score scene: the camera is fixed", () => {
  it("updating with any history, clock or loudness never moves the camera", () => {
    const s = new ScoreScene();
    s.setViewport(1248, 563, 1);
    const pos = s.camera.position.clone();
    const quat = s.camera.quaternion.clone();
    const h = new ScoreHistory();
    const a = createScoreAnim();
    for (let i = 0; i < 200; i++) {
      h.push(fr({ time: i * 0.03, bass: (i % 7) / 7 }));
      a.now = i * 0.03;
      a.illumination = (i % 10) / 10;
      s.update(h, a, P);
    }
    assert.ok(s.camera.position.equals(pos));
    assert.ok(s.camera.quaternion.equals(quat));
    s.dispose();
  });

  it("the camera looks straight ahead (no pitch), so vertical lines stay vertical", () => {
    const s = new ScoreScene();
    s.setViewport(1248, 563, 1);
    const d = new THREE.Vector3();
    s.camera.getWorldDirection(d);
    assert.ok(Math.abs(d.y) < 1e-9 && Math.abs(d.x) < 1e-9);
    s.dispose();
  });

  it("the same time lands at the same screen x in every lane, on the grid and on a marker (depth is compensated)", () => {
    const s = new ScoreScene();
    s.setViewport(1248, 563, 1);
    s.camera.updateMatrixWorld();
    const age = 5; // seconds behind the current-time boundary
    const xWorld = NOW_X - age * UNITS_PER_S;
    const screenX = (layer: { u: { value: number }; z: number }) => new THREE.Vector3(xWorld * layer.u.value, 0, layer.z).project(s.camera).x;
    const layers = (s as unknown as { xs: Array<{ u: { value: number }; z: number }> }).xs;
    assert.ok(layers.length >= 5, "three lanes, the grid and the markers each carry a compensation");
    const xs = layers.map(screenX);
    for (const x of xs) assert.ok(Math.abs(x - xs[0]) < 1e-3, `screen x ${x} vs ${xs[0]}`);
    s.dispose();
  });

  it("the whole instrument fits at wide, phone and square sizes", () => {
    const s = new ScoreScene();
    for (const [w, h] of [[1248, 563], [358, 352], [900, 900], [1920, 600]] as const) {
      s.setViewport(w, h, 1);
      s.camera.updateMatrixWorld();
      // The instrument's real extent: from the left edge of the window to the boundary, and from the top lane's upper rule to the bottom lane's lower rule.
      const top = LANES[0].y + LANE_H, bottom = LANES[2].y - LANE_H;
      const tl = new THREE.Vector3(LEFT_X, top, 0).project(s.camera);
      const br = new THREE.Vector3(NOW_X, bottom, 0).project(s.camera);
      assert.ok(tl.x >= -1 && tl.y <= 1 && br.x <= 1 && br.y >= -1, `${w}x${h}: (${tl.x}, ${tl.y}) (${br.x}, ${br.y})`);
    }
    s.setViewport(0, 0, 1);
    s.dispose();
  });
});

describe("Score scene: buffers follow the history", () => {
  it("lane buffers hold the samples in time order, and markers hold the marker times", () => {
    const s = new ScoreScene();
    const h = new ScoreHistory();
    for (let i = 0; i < 100; i++) h.push(fr({ time: i * 0.03, beatDetected: i % 25 === 3, bass: i / 100 }));
    s.update(h, createScoreAnim(), P);
    const aT = s.lanes[0].geometry.getAttribute("aT");
    assert.ok(aT.getX(0) < aT.getX(2) && aT.getX(2) < aT.getX(198));
    assert.equal(aT.getX(0), aT.getX(1), "both sides of a strip share one time");
    const mT = s.markerLines.geometry.getAttribute("aT");
    const want = Array.from({ length: h.markerCount }, (_, i) => h.markT[h.markerIndexOf(i)]);
    assert.deepEqual(want.map((_, i) => Math.round(mT.getX(i * 2) * 1000) / 1000), want.map((t) => Math.round(t * 1000) / 1000));
    assert.equal(mT.getX(h.markerCount * 2), -1e9, "unused marker slots are hidden");
    assert.equal(s.lanes[0].geometry.drawRange.count, (h.count - 1) * 6);
    s.dispose();
  });

  it("buffers are uploaded only when the history changed, not on every draw", () => {
    const s = new ScoreScene();
    const h = new ScoreHistory();
    for (let i = 0; i < 50; i++) h.push(fr({ time: i * 0.03 }));
    const a = createScoreAnim();
    s.update(h, a, P);
    const u0 = { ...s.uploads };
    for (let i = 0; i < 100; i++) s.update(h, a, P); // 100 draws, no new data
    assert.deepEqual({ ...s.uploads }, u0);
    h.push(fr({ time: 5 }));
    s.update(h, a, P);
    assert.equal(s.uploads.lanes, u0.lanes + 1);
    assert.equal(s.uploads.markers, u0.markers, "no new marker, no marker upload");
    h.push(fr({ time: 5.5, beatDetected: true }));
    s.update(h, a, P);
    assert.equal(s.uploads.markers, u0.markers + 1);
    s.dispose();
  });

  it("a break in the record leaves a hole in the geometry: the segment before a broken sample draws nothing", () => {
    const s = new ScoreScene();
    const h = new ScoreHistory();
    h.push(fr({ time: 1 }));
    h.push(fr({ time: 1.05 }));
    h.push(fr({ time: 9 })); // a seek forward: broken
    h.push(fr({ time: 9.05 }));
    s.update(h, createScoreAnim(), P);
    const idx = s.lanes[0].geometry.index!;
    const seg = (i: number) => Array.from({ length: 6 }, (_, k) => idx.getX(i * 6 + k));
    assert.ok(seg(0).some((v) => v !== 0), "joined segment draws");
    assert.deepEqual(seg(1), [0, 0, 0, 0, 0, 0], "the broken segment draws nothing");
    assert.ok(seg(2).some((v) => v !== 0));
    s.dispose();
  });

  it("a reset clears the lanes and markers on the next update", () => {
    const s = new ScoreScene();
    const h = new ScoreHistory();
    for (let i = 0; i < 40; i++) h.push(fr({ time: i * 0.03, beatDetected: i === 10 }));
    s.update(h, createScoreAnim(), P);
    h.reset();
    s.update(h, createScoreAnim(), P);
    assert.equal(s.lanes[0].geometry.drawRange.count, 0);
    assert.equal(s.markerLines.geometry.getAttribute("aT").getX(0), -1e9);
    s.dispose();
  });

  it("writes the clock and illumination into the uniforms the shaders read", () => {
    const s = new ScoreScene();
    const a = createScoreAnim();
    a.now = 12.5;
    a.illumination = 0.8;
    a.active = 1;
    s.update(new ScoreHistory(), a, toScoreParams(fr(), true));
    assert.equal(s.uniforms.uNow.value, 12.5);
    assert.equal(s.uniforms.uIllum.value, 0.8);
    assert.equal(s.uniforms.uActive.value, 1);
    assert.equal(s.uniforms.uReduced.value, 1);
    s.dispose();
  });

  it("every uniform a shader declares is supplied by its material", () => {
    const s = new ScoreScene();
    s.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (!m || !m.isShaderMaterial) return;
      const declared = [...(m.vertexShader + "\n" + m.fragmentShader).matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((x) => x[1]);
      for (const name of new Set(declared)) assert.ok(name in m.uniforms, `${name} is declared but not supplied`);
    });
    s.dispose();
  });

  it("buffer sizes are fixed by the history capacity (bounded memory)", () => {
    const s = new ScoreScene();
    assert.equal(s.lanes[0].geometry.getAttribute("aT").count, HISTORY_CAPACITY * 2);
    assert.equal(s.markerLines.geometry.getAttribute("aT").count, MARKER_CAPACITY * 2);
    s.dispose();
  });
});

describe("Score scene: ownership and disposal", () => {
  it("everything in the scene graph is owned", () => {
    const s = new ScoreScene();
    const { geometries, materials } = collect(s);
    assert.equal(geometries.length, s.resourceCounts.geometries);
    assert.equal(materials.length, s.resourceCounts.materials);
    s.dispose();
  });

  it("dispose releases every geometry and material exactly once", () => {
    const s = new ScoreScene();
    const { geometries, materials } = collect(s);
    let events = 0;
    for (const r of [...geometries, ...materials]) r.addEventListener("dispose", () => events++);
    const before = { ...sceneStats };
    s.dispose();
    assert.equal(events, geometries.length + materials.length);
    assert.equal(s.scene.children.length, 0);
    s.dispose();
    assert.equal(events, geometries.length + materials.length);
    assert.equal(sceneStats.disposed, before.disposed + 1);
  });

  it("releaseGpu keeps the scene graph and makes the next update re-fill the buffers", () => {
    const s = new ScoreScene();
    const h = new ScoreHistory();
    for (let i = 0; i < 20; i++) h.push(fr({ time: i * 0.03 }));
    s.update(h, createScoreAnim(), P);
    const kids = s.scene.children.length;
    const u = s.uploads.lanes;
    s.releaseGpu();
    assert.equal(s.scene.children.length, kids);
    s.update(h, createScoreAnim(), P);
    assert.equal(s.uploads.lanes, u + 1);
    s.dispose();
  });

  it("update and releaseGpu after dispose do nothing and do not throw", () => {
    const s = new ScoreScene();
    s.dispose();
    assert.doesNotThrow(() => {
      s.update(new ScoreHistory(), createScoreAnim(), P);
      s.releaseGpu();
    });
  });

  it("created and disposed counters balance", () => {
    const a = { ...sceneStats };
    new ScoreScene().dispose();
    assert.equal(sceneStats.created, a.created + 1);
    assert.equal(sceneStats.disposed, a.disposed + 1);
  });
});
