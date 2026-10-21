import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";

import { createResonatorAnim } from "../src/lib/resonator/animator";
import {
  BARS_PER_ARC, BEADS_PER_TRACK, FIT_HALF_WIDTH, HEART_Y, ORB_RADIUS, PARTICLE_COUNT, RING_COUNT, R_OUT, TRACK_RADII, ResonatorScene, environmentData, ringStrip, sceneStats,
} from "../src/lib/resonator/scene";

// Three.js builds scenes, geometry and materials without a GPU, so structure, ownership, disposal, framing and uniform mapping
// are tested here. Shader compilation and drawing are checked in the browser (preview/resonator-check.mjs).

const VIEW = { azimuth: 0, elevation: 0 };

function collect(s: ResonatorScene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  s.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geometries.add(m.geometry);
    if (m.material) {
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => {
        materials.add(x);
        const env = (x as THREE.MeshPhysicalMaterial).envMap;
        if (env) textures.add(env);
      });
    }
  });
  return { geometries: [...geometries], materials: [...materials], textures: [...textures] };
}

describe("Resonator scene: composition", () => {
  it("has 16 to 32 ribbon rings, drawn as one mesh", () => {
    assert.ok(RING_COUNT >= 16 && RING_COUNT <= 32, `RING_COUNT ${RING_COUNT}`);
    const s = new ResonatorScene();
    const pos = s.ribbons.geometry.getAttribute("position");
    const rings = new Set<number>();
    for (let i = 0; i < pos.count; i++) rings.add(pos.getZ(i));
    assert.equal(rings.size, RING_COUNT);
    assert.equal(Math.min(...rings), 0);
    assert.equal(Math.max(...rings), RING_COUNT - 1);
    s.dispose();
  });

  it("ribbon vertices carry (angle, side, ring): angle spans one turn and side is -1 or 1", () => {
    const g = ringStrip(32, 2, (r) => r);
    const p = g.getAttribute("position");
    let maxAngle = 0;
    for (let i = 0; i < p.count; i++) {
      maxAngle = Math.max(maxAngle, p.getX(i));
      assert.ok(p.getY(i) === -1 || p.getY(i) === 1);
    }
    assert.ok(Math.abs(maxAngle - Math.PI * 2) < 1e-6);
    assert.equal(p.count, 2 * 33 * 2);
    assert.equal(g.index!.count, 2 * 32 * 6);
    g.dispose();
  });

  it("the orb is a physical glass: transmission 0.95, roughness 0.1, ior 1.5", () => {
    const s = new ResonatorScene();
    const m = s.orb.material as THREE.MeshPhysicalMaterial;
    assert.equal(m.type, "MeshPhysicalMaterial");
    assert.equal(m.transmission, 0.95);
    assert.equal(m.roughness, 0.1);
    assert.equal(m.ior, 1.5);
    assert.equal((s.orb.geometry as THREE.SphereGeometry).parameters.radius, ORB_RADIUS);
    s.dispose();
  });

  it("the heart holds a warm point light, the plasma and the lattice", () => {
    const s = new ResonatorScene();
    assert.ok(s.light.isPointLight);
    assert.ok(s.light.color.r > s.light.color.b, "warm");
    assert.ok(s.heart.children.includes(s.light));
    assert.ok(s.heart.children.some((c) => (c as THREE.LineSegments).isLineSegments), "lattice");
    assert.equal(s.heart.position.y, HEART_Y);
    s.dispose();
  });

  it("beads are an InstancedMesh with one orbit record per bead, on the fixed track radii", () => {
    const s = new ResonatorScene();
    const total = BEADS_PER_TRACK.reduce((a, b) => a + b, 0);
    assert.ok(s.beads.isInstancedMesh);
    assert.equal(s.beads.count, total);
    const orbit = s.beads.geometry.getAttribute("aOrbit");
    assert.equal(orbit.count, total);
    const radii = new Set<number>();
    for (let i = 0; i < orbit.count; i++) radii.add(Math.round(orbit.getX(i) * 1000) / 1000);
    assert.deepEqual([...radii].sort((a, b) => a - b), [...TRACK_RADII].map((r) => Math.round(r * 1000) / 1000));
    assert.ok(s.bars.isInstancedMesh);
    assert.equal(s.bars.count, BARS_PER_ARC * 2);
    s.dispose();
  });

  it("the particle field has the configured count", () => {
    const s = new ResonatorScene();
    const pts = s.scene.getObjectsByProperty("isPoints", true) as THREE.Points[];
    assert.equal(pts.length, 1);
    assert.equal(pts[0].geometry.getAttribute("aSeed").count, PARTICLE_COUNT);
    s.dispose();
  });

  it("the layout is deterministic: two scenes have identical bead and bar records", () => {
    const a = new ResonatorScene(), b = new ResonatorScene();
    assert.deepEqual(Array.from(a.beads.geometry.getAttribute("aOrbit").array), Array.from(b.beads.geometry.getAttribute("aOrbit").array));
    assert.deepEqual(Array.from(a.bars.geometry.getAttribute("aBar").array), Array.from(b.bars.geometry.getAttribute("aBar").array));
    a.dispose();
    b.dispose();
  });

  it("the procedural environment is fully opaque RGBA with a bright panel", () => {
    const d = environmentData(32, 16);
    assert.equal(d.length, 32 * 16 * 4);
    for (let i = 3; i < d.length; i += 4) assert.equal(d[i], 255);
    assert.ok(Math.max(...d) > 200);
  });
});

describe("Resonator scene: quality tiers", () => {
  it("full has transmission and the mirrored floor; lite has neither", () => {
    const full = new ResonatorScene({ quality: "full" });
    const lite = new ResonatorScene({ quality: "lite" });
    assert.ok((full.orb.material as THREE.MeshPhysicalMaterial).transmission > 0);
    assert.equal((lite.orb.material as THREE.MeshPhysicalMaterial).transmission, 0);
    assert.ok((lite.orb.material as THREE.MeshPhysicalMaterial).transparent);
    const mirror = (s: ResonatorScene) => s.scene.children.find((c) => c.scale.y === -1)!;
    assert.equal(mirror(full).visible, true);
    assert.equal(mirror(lite).visible, false);
    full.dispose();
    lite.dispose();
  });

  it("the default is full", () => {
    const s = new ResonatorScene();
    assert.equal(s.quality, "full");
    s.dispose();
  });
});

describe("Resonator scene: ownership and disposal", () => {
  it("everything in the scene graph is owned, so dispose can release it", () => {
    const s = new ResonatorScene();
    const { geometries, materials, textures } = collect(s);
    const own = s.resourceCounts;
    assert.equal(geometries.length, own.geometries);
    assert.equal(materials.length, own.materials);
    assert.equal(textures.length, own.textures);
    s.dispose();
  });

  it("dispose releases every geometry, material and texture, exactly once", () => {
    const s = new ResonatorScene();
    const { geometries, materials, textures } = collect(s);
    let events = 0;
    for (const r of [...geometries, ...materials, ...textures]) r.addEventListener("dispose", () => events++);
    const before = { ...sceneStats };
    s.dispose();
    assert.equal(events, geometries.length + materials.length + textures.length);
    assert.equal(s.scene.children.length, 0);
    assert.equal(sceneStats.disposed, before.disposed + 1);
    s.dispose();
    assert.equal(events, geometries.length + materials.length + textures.length, "a second dispose does nothing");
    assert.equal(sceneStats.disposed, before.disposed + 1);
  });

  it("releaseGpu disposes the GPU records but keeps the scene graph, so a restore can re-upload", () => {
    const s = new ResonatorScene();
    const { geometries, materials, textures } = collect(s);
    let events = 0;
    for (const r of [...geometries, ...materials, ...textures]) r.addEventListener("dispose", () => events++);
    const kids = s.scene.children.length;
    s.releaseGpu();
    assert.equal(events, geometries.length + materials.length + textures.length);
    assert.equal(s.scene.children.length, kids);
    s.dispose();
  });

  it("update and releaseGpu after dispose do nothing and do not throw", () => {
    const s = new ResonatorScene();
    s.dispose();
    assert.doesNotThrow(() => {
      s.update(createResonatorAnim(), VIEW);
      s.releaseGpu();
    });
  });

  it("created and disposed counters balance", () => {
    const a = { ...sceneStats };
    new ResonatorScene().dispose();
    assert.equal(sceneStats.created, a.created + 1);
    assert.equal(sceneStats.disposed, a.disposed + 1);
  });
});

describe("Resonator scene: framing", () => {
  it("backs off on narrow canvases so the outer ribbon always fits the width", () => {
    const s = new ResonatorScene();
    s.setViewport(1248, 563, 1);
    const wide = s.distance;
    s.setViewport(358, 352, 1);
    const narrow = s.distance;
    assert.ok(narrow > wide, `narrow ${narrow} vs wide ${wide}`);
    const tanHalf = Math.tan((36 * Math.PI) / 360);
    assert.ok(Math.abs(narrow * tanHalf * (358 / 352) - FIT_HALF_WIDTH) < 1e-6, "narrow canvases show exactly FIT_HALF_WIDTH");
    assert.ok(FIT_HALF_WIDTH > R_OUT);
    s.dispose();
  });

  it("a wide, short canvas backs off for the height: the near edge of the outer ribbon stays inside the frame", () => {
    const s = new ResonatorScene();
    s.setViewport(1248, 563, 1);
    s.update(createResonatorAnim(), VIEW);
    s.camera.updateMatrixWorld();
    const near = new THREE.Vector3(0, 0, R_OUT).project(s.camera);
    assert.ok(Math.abs(near.y) < 1 && Math.abs(near.x) < 1, `near edge at ndc (${near.x}, ${near.y})`);
    const left = new THREE.Vector3(-R_OUT, 0, 0).project(s.camera);
    const right = new THREE.Vector3(R_OUT, 0, 0).project(s.camera);
    assert.ok(left.x > -1 && right.x < 1);
    s.dispose();
  });

  it("ignores a zero-size canvas", () => {
    const s = new ResonatorScene();
    s.setViewport(800, 400, 1);
    const d = s.distance;
    s.setViewport(0, 0, 1);
    assert.equal(s.distance, d);
    s.dispose();
  });

  it("the camera moves closer as the scene level rises", () => {
    const s = new ResonatorScene();
    s.setViewport(1248, 563, 1);
    const a = createResonatorAnim();
    s.update(a, VIEW);
    const far = s.camera.position.length();
    a.sceneLevel = 1;
    s.update(a, VIEW);
    assert.ok(s.camera.position.length() < far);
    s.dispose();
  });
});

describe("Resonator scene: update", () => {
  it("every uniform a shader declares is supplied by its material (no shader reads an unset value)", () => {
    const s = new ResonatorScene();
    s.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (!m || !m.isShaderMaterial) return;
      const declared = [...(m.vertexShader + "\n" + m.fragmentShader).matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((x) => x[1]);
      for (const name of new Set(declared)) assert.ok(name in m.uniforms, `${name} is declared but not supplied`);
    });
    s.dispose();
  });

  const uniformOf = (s: ResonatorScene, name: string) => s.uniforms[name].value;

  it("writes each animator value into the uniform the shaders read", () => {
    const s = new ResonatorScene();
    const a = createResonatorAnim();
    Object.assign(a, { rise: 0.7, radial: 0.6, ripple: 0.5, rippleRate: 0.5, phaseMid: 1.5, phaseHigh: 2.5, exposure: 0.8, glow: 0.9, flash: 0.4, burst: 0.3, atmosphere: 0.6, bloom: 0.5 });
    s.update(a, VIEW);
    assert.equal(uniformOf(s, "uRise"), 0.7);
    assert.equal(uniformOf(s, "uRadial"), 0.6);
    assert.equal(uniformOf(s, "uRipple"), 0.5);
    assert.equal(uniformOf(s, "uRippleFreq"), 6 + 10 * 0.5);
    assert.equal(uniformOf(s, "uPhaseMid"), 1.5);
    assert.equal(uniformOf(s, "uPhaseHigh"), 2.5);
    assert.equal(uniformOf(s, "uExposure"), 0.8);
    assert.equal(uniformOf(s, "uFlash"), 0.4);
    assert.equal(uniformOf(s, "uBurst"), 0.3);
    s.dispose();
  });

  it("the mirrored copy and the real light share the same uniform objects, so one write feeds both", () => {
    const s = new ResonatorScene();
    const mirror = s.scene.children.find((c) => c.scale.y === -1)!;
    const mirrorRibbons = (mirror.children[0] as THREE.Group).children[0] as THREE.Mesh;
    const a = (s.ribbons.material as THREE.ShaderMaterial).uniforms;
    const b = (mirrorRibbons.material as THREE.ShaderMaterial).uniforms;
    assert.equal(a.uRise, b.uRise);
    assert.equal(a.uRise, s.uniforms.uRise);
    assert.notEqual(a.uMirror, b.uMirror);
    assert.ok((b.uMirror as { value: number }).value < (a.uMirror as { value: number }).value);
    s.dispose();
  });

  it("bass swells the orb and the plasma; a bass hit swells it further; the warm light follows the glow", () => {
    const s = new ResonatorScene();
    const a = createResonatorAnim();
    s.update(a, VIEW);
    const rest = { orb: s.orb.scale.x, light: s.light.intensity };
    a.swell = 1;
    a.glow = 1;
    s.update(a, VIEW);
    assert.ok(s.orb.scale.x > rest.orb);
    assert.ok(s.light.intensity > rest.light);
    const swollen = s.orb.scale.x;
    a.kick = 1;
    s.update(a, VIEW);
    assert.ok(s.orb.scale.x > swollen);
    assert.ok(s.orb.scale.x < 1.25, "never a violent scale");
    s.dispose();
  });
});
