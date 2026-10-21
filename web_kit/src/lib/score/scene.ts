import * as THREE from "three";

import type { ScoreAnim } from "./animator";
import { HISTORY_CAPACITY, HISTORY_WINDOW_S, MARKER_CAPACITY, type ScoreHistory } from "./history";
import type { ScoreParams } from "./params";
import {
  GRID_FRAG, GRID_VERT, LANE_FRAG, LANE_VERT, MARK_LINE_FRAG, MARK_POINT_FRAG, MARK_VERT, NOW_FRAG, NOW_VERT, PLATE_FRAG, PLATE_VERT, RULE_FRAG, RULE_VERT,
} from "./shaders";

/**
 * The Score scene: a precision temporal instrument. Three horizontal signal lanes (bass, mid, high) in a shallow depth stack,
 * a second-by-second time grid, onset markers, and a current-time boundary on the right where new history enters. History
 * scrolls right to left; the camera never moves.
 *
 * Everything is built once in the constructor. `update` writes uniforms and, only when the history has changed, re-fills the
 * preallocated attribute arrays, so a frame allocates nothing. `dispose` releases every geometry and material.
 *
 * Draw order (all transparent, none writes depth): plates, grid, rules, lanes (back to front), markers, boundary.
 * `decor: false` removes the plates, leaving only the lanes, grid, rules, markers and boundary: the geometry that carries the
 * identity. Sizes and rates are PROPOSED values for visual review, not measured quantities.
 */

/** Module-level counts, so lifecycle checks can confirm every scene created was disposed. */
export const sceneStats = { created: 0, disposed: 0 };

/** Lane colours as specified: bass amber, mid cyan, high electric violet. */
export const LANE_HEX = { bass: "#FF9900", mid: "#00F0FF", high: "#9D00FF" } as const;
const hexToRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** The right-hand current-time boundary, the scroll speed, and the visible window. */
export const NOW_X = 7.2;
export const WINDOW_S = HISTORY_WINDOW_S;
export const UNITS_PER_S = 1.25;
/** Left edge of the visible window in world x: NOW_X - WINDOW_S * UNITS_PER_S. */
export const LEFT_X = NOW_X - WINDOW_S * UNITS_PER_S;
/** Half-height of a lane's drawing area, world units. */
export const LANE_H = 1.05;
/** Lanes top to bottom: high, mid, bass. y and depth (z): the stack recedes towards the top, a shallow, fixed parallax. */
export const LANES = [
  { id: "high", y: 2.3, z: -1.6, hex: LANE_HEX.high },
  { id: "mid", y: 0, z: -0.8, hex: LANE_HEX.mid },
  { id: "bass", y: -2.3, z: 0, hex: LANE_HEX.bass },
] as const;
export const GRID_Y0 = -3.7;
export const GRID_Y1 = 3.7;
export const GRID_Z = -2.2;
/** Grid lines kept: the window in whole seconds plus two. */
export const GRID_N = Math.ceil(HISTORY_WINDOW_S) + 2;
const FOV = 30;
/** The camera sits slightly above the stack and looks straight ahead (no pitch), so vertical lines stay vertical. */
const CAMERA_HEIGHT = 0.9;
const BASE_DISTANCE = 14;
/** Half-width and half-height of the content to keep in view, world units. */
export const FIT_HALF_WIDTH = 8.4;
export const FIT_HALF_HEIGHT = 4.7;

export interface ScoreOptions {
  /** Draw the lane plates behind the lanes. Default true. Everything else is core geometry and is always drawn. */
  decor?: boolean;
}

type Uniform = { value: number | THREE.Vector3 };
const f = (n: number) => n.toFixed(4);

export class ScoreScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 100);
  readonly decor: boolean;
  /** The three lane meshes (high, mid, bass) and the onset-marker objects, exposed for tests and diagnostics. */
  readonly lanes: THREE.Mesh[] = [];
  readonly markerLines: THREE.LineSegments;
  readonly markerHeads: THREE.Points;
  readonly plates: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly u: Record<string, Uniform> = {};
  private readonly laneGeo: THREE.BufferGeometry;
  private readonly laneT: Float32Array;
  private readonly laneVal: Float32Array;
  private readonly laneMeta: Float32Array;
  private readonly laneIndex: Uint16Array;
  private readonly markGeo: THREE.BufferGeometry;
  private readonly markT: Float32Array;
  private readonly markS: Float32Array;
  private readonly xs: Array<{ u: Uniform; z: number }> = [];
  private readonly xsMeshes: Array<{ m: THREE.Object3D; z: number; x: number }> = [];
  private seenAppended = -1;
  private seenResets = -1;
  private seenOnsets = -1;
  private seenMarkers = -1;
  private fitDistance = BASE_DISTANCE;
  private pixelRatio = 1;
  private disposed = false;
  /** Diagnostics: how many times the lane and marker buffers were re-filled. */
  uploads = { lanes: 0, markers: 0 };

  constructor(opts: ScoreOptions = {}) {
    this.decor = opts.decor !== false;
    this.u.uNow = { value: 0 };
    this.u.uIllum = { value: 0.35 };
    this.u.uActive = { value: 0 };
    this.u.uScale = { value: 1 };
    this.u.uReduced = { value: 0 };

    const defines = {
      NOW_X: f(NOW_X), UNITS_PER_S: f(UNITS_PER_S), WINDOW_S: f(WINDOW_S), LANE_H: f(LANE_H), GRID_Y0: f(GRID_Y0), GRID_Y1: f(GRID_Y1), GRID_Z: f(GRID_Z),
    };
    const material = (vs: string, fs: string, uni: Record<string, Uniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      this.ownMat(new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: uni, defines, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, ...extra }));
    const shared = (...names: string[]) => Object.fromEntries(names.map((n) => [n, this.u[n]]));
    // Layers at different depths would land the same time at different screen x. Each layer carries uXs = (distance - z) / distance,
    // set in setViewport, which cancels that, so a sample, a grid line and a marker for the same time share one screen x.
    const xs = (z: number): Uniform => {
      const u = { value: 1 };
      this.xs.push({ u, z });
      return u;
    };

    // --- lanes: one geometry, three materials --------------------------------------------------------------------
    const nv = HISTORY_CAPACITY * 2;
    this.laneT = new Float32Array(nv);
    this.laneVal = new Float32Array(nv * 4);
    this.laneMeta = new Float32Array(nv * 2);
    this.laneIndex = new Uint16Array((HISTORY_CAPACITY - 1) * 6);
    const side = new Float32Array(nv);
    for (let i = 0; i < nv; i++) side[i] = i % 2 === 0 ? -1 : 1;
    this.laneGeo = this.own(new THREE.BufferGeometry());
    const pos = new Float32Array(nv * 3); // required by three.js for the vertex count; the shader builds the real position
    this.laneGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.laneGeo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    this.laneGeo.setAttribute("aT", new THREE.BufferAttribute(this.laneT, 1).setUsage(THREE.DynamicDrawUsage));
    this.laneGeo.setAttribute("aVal", new THREE.BufferAttribute(this.laneVal, 4).setUsage(THREE.DynamicDrawUsage));
    this.laneGeo.setAttribute("aMeta", new THREE.BufferAttribute(this.laneMeta, 2).setUsage(THREE.DynamicDrawUsage));
    this.laneGeo.setIndex(new THREE.BufferAttribute(this.laneIndex, 1).setUsage(THREE.DynamicDrawUsage));
    this.laneGeo.setDrawRange(0, 0);

    // Static back layers first: plates, grid, rules.
    LANES.forEach((lane) => {
      if (!this.decor) return;
      const geo = this.own(new THREE.PlaneGeometry(NOW_X - LEFT_X, LANE_H * 2.1));
      const m = new THREE.Mesh(geo, material(PLATE_VERT, PLATE_FRAG, { ...shared("uIllum"), uColour: { value: new THREE.Vector3(...hexToRgb(lane.hex)) } }));
      m.position.set((NOW_X + LEFT_X) / 2, lane.y, lane.z - 0.05);
      this.xsMeshes.push({ m, z: lane.z - 0.05, x: (NOW_X + LEFT_X) / 2 });
      m.renderOrder = 1;
      m.frustumCulled = false;
      this.plates.push(m);
      this.scene.add(m);
    });

    const gridPos = new Float32Array(GRID_N * 2 * 3);
    const gridK = new Float32Array(GRID_N * 2);
    const gridEnd = new Float32Array(GRID_N * 2);
    for (let k = 0; k < GRID_N; k++) {
      gridK[k * 2] = gridK[k * 2 + 1] = k;
      gridEnd[k * 2 + 1] = 1;
    }
    const gridGeo = this.own(new THREE.BufferGeometry());
    gridGeo.setAttribute("position", new THREE.BufferAttribute(gridPos, 3));
    gridGeo.setAttribute("aK", new THREE.BufferAttribute(gridK, 1));
    gridGeo.setAttribute("aEnd", new THREE.BufferAttribute(gridEnd, 1));
    const grid = new THREE.LineSegments(gridGeo, material(GRID_VERT, GRID_FRAG, { ...shared("uNow", "uIllum"), uXs: xs(GRID_Z) }));
    grid.renderOrder = 2;
    grid.frustumCulled = false;
    this.scene.add(grid);

    // Rules: a baseline for each lane and the lane's top and bottom limits, in the lane's colour at low alpha.
    for (const lane of LANES) {
      const rgb = hexToRgb(lane.hex);
      const rules: number[] = [];
      const cols: number[] = [];
      for (const [dy, a] of [[0, 0.38], [LANE_H, 0.10], [-LANE_H, 0.10]] as const) {
        rules.push(LEFT_X, lane.y + dy, lane.z, NOW_X, lane.y + dy, lane.z);
        cols.push(...rgb, a, ...rgb, a);
      }
      const ruleGeo = this.own(new THREE.BufferGeometry());
      ruleGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rules), 3));
      ruleGeo.setAttribute("aCol", new THREE.BufferAttribute(new Float32Array(cols), 4));
      const ruleMesh = new THREE.LineSegments(ruleGeo, material(RULE_VERT, RULE_FRAG, shared("uIllum")));
      this.xsMeshes.push({ m: ruleMesh, z: lane.z, x: 0 });
      ruleMesh.renderOrder = 3;
      ruleMesh.frustumCulled = false;
      this.scene.add(ruleMesh);
    }

    // Lanes, back (high) to front (bass).
    LANES.forEach((lane, i) => {
      const m = new THREE.Mesh(
        this.laneGeo,
        material(LANE_VERT, LANE_FRAG, { ...shared("uNow", "uIllum"), uLane: { value: 2 - i }, uLaneY: { value: lane.y }, uLaneZ: { value: lane.z }, uXs: xs(lane.z), uColour: { value: new THREE.Vector3(...hexToRgb(lane.hex)) } }),
      );
      m.renderOrder = 4 + i;
      m.frustumCulled = false;
      this.lanes.push(m);
      this.scene.add(m);
    });

    // --- onset markers: a rule and a diamond head per marker, one shared geometry (two vertices per marker) -----------------
    const mv = MARKER_CAPACITY * 2;
    this.markT = new Float32Array(mv).fill(-1e9);
    this.markS = new Float32Array(mv);
    const markEnd = new Float32Array(mv);
    for (let i = 0; i < MARKER_CAPACITY; i++) markEnd[i * 2 + 1] = 1;
    this.markGeo = this.own(new THREE.BufferGeometry());
    this.markGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mv * 3), 3));
    this.markGeo.setAttribute("aT", new THREE.BufferAttribute(this.markT, 1).setUsage(THREE.DynamicDrawUsage));
    this.markGeo.setAttribute("aS", new THREE.BufferAttribute(this.markS, 1).setUsage(THREE.DynamicDrawUsage));
    this.markGeo.setAttribute("aEnd", new THREE.BufferAttribute(markEnd, 1));
    const markU = { ...shared("uNow", "uScale", "uReduced"), uXs: xs(GRID_Z + 0.05) };
    this.markerLines = new THREE.LineSegments(this.markGeo, material(MARK_VERT, MARK_LINE_FRAG, markU));
    this.markerHeads = new THREE.Points(this.markGeo, material(MARK_VERT, MARK_POINT_FRAG, markU));
    for (const m of [this.markerLines, this.markerHeads]) {
      m.renderOrder = 8;
      m.frustumCulled = false;
      this.scene.add(m);
    }

    // --- the current-time boundary -----------------------------------------------------------------------------------
    const nowGeo = this.own(new THREE.PlaneGeometry(0.04, GRID_Y1 - GRID_Y0));
    const nowMesh = new THREE.Mesh(nowGeo, material(NOW_VERT, NOW_FRAG, shared("uActive", "uIllum")));
    nowMesh.position.set(NOW_X, (GRID_Y0 + GRID_Y1) / 2, GRID_Z + 0.08);
    this.xsMeshes.push({ m: nowMesh, z: GRID_Z + 0.08, x: NOW_X });
    nowMesh.renderOrder = 9;
    nowMesh.frustumCulled = false;
    this.scene.add(nowMesh);

    this.placeCamera();
    sceneStats.created++;
  }

  /** What the scene owns, for lifecycle tests. */
  get resourceCounts() {
    return { geometries: this.geometries.length, materials: this.materials.length };
  }

  /** The shared uniform values the shaders read, for tests and diagnostics. */
  get uniforms(): Readonly<Record<string, Uniform>> {
    return this.u;
  }

  /** The camera distance that keeps the whole instrument inside the canvas. */
  get distance(): number {
    return this.fitDistance;
  }

  /** Call when the canvas size or pixel ratio changes. Framing keeps the full width and the full lane stack in view. */
  setViewport(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    if (cssWidth < 1 || cssHeight < 1) return;
    const aspect = cssWidth / cssHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    this.fitDistance = Math.max(BASE_DISTANCE, FIT_HALF_WIDTH / (tanHalf * aspect), FIT_HALF_HEIGHT / tanHalf);
    this.pixelRatio = pixelRatio;
    this.u.uScale.value = pixelRatio * (cssHeight / 720);
    this.placeCamera();
  }

  /** The camera is fixed: it is placed here and nowhere else, and never moves with the music. Also sets each layer's depth compensation. */
  private placeCamera(): void {
    const d = this.fitDistance;
    this.camera.position.set(0, CAMERA_HEIGHT, d);
    this.camera.lookAt(0, CAMERA_HEIGHT, 0);
    for (const e of this.xs) e.u.value = (d - e.z) / d;
    for (const e of this.xsMeshes) {
      const k = (d - e.z) / d;
      e.m.scale.x = k;
      e.m.position.x = e.x * k;
    }
  }

  /** Writes the history and animation state into uniforms and, only if the history changed, the attribute buffers. No allocation. */
  update(h: ScoreHistory, a: ScoreAnim, p: ScoreParams): void {
    if (this.disposed) return;
    const u = this.u;
    u.uNow.value = a.now;
    u.uIllum.value = a.illumination;
    u.uActive.value = a.active;
    u.uReduced.value = p.reduced ? 1 : 0;
    if (h.stats.appended !== this.seenAppended || h.stats.resets !== this.seenResets) this.uploadLanes(h);
    if (h.stats.onsets !== this.seenOnsets || h.stats.resets !== this.seenResets || h.markerCount !== this.seenMarkers) this.uploadMarkers(h);
    this.seenAppended = h.stats.appended;
    this.seenOnsets = h.stats.onsets;
    this.seenResets = h.stats.resets;
    this.seenMarkers = h.markerCount;
  }

  private uploadLanes(h: ScoreHistory): void {
    const n = h.count;
    for (let i = 0; i < n; i++) {
      const k = h.indexOf(i);
      const v = i * 2;
      const t = h.t[k];
      this.laneT[v] = this.laneT[v + 1] = t;
      for (let s = 0; s < 2; s++) {
        const o = (v + s) * 4;
        this.laneVal[o] = h.bass[k];
        this.laneVal[o + 1] = h.mid[k];
        this.laneVal[o + 2] = h.high[k];
        this.laneVal[o + 3] = h.hit[k];
        this.laneMeta[(v + s) * 2] = h.seq[k] % 2 === 0 ? 1 : -1;
      }
      // Segment (i-1, i): a quad, or nothing where the line is broken (a gap or the first sample of a run).
      if (i > 0) {
        const o = (i - 1) * 6;
        if (h.brk[k]) this.laneIndex.fill(0, o, o + 6);
        else {
          const a = (i - 1) * 2;
          this.laneIndex[o] = a; this.laneIndex[o + 1] = a + 1; this.laneIndex[o + 2] = a + 2;
          this.laneIndex[o + 3] = a + 1; this.laneIndex[o + 4] = a + 3; this.laneIndex[o + 5] = a + 2;
        }
      }
    }
    this.laneGeo.setDrawRange(0, n >= 2 ? (n - 1) * 6 : 0);
    for (const name of ["aT", "aVal", "aMeta"]) this.laneGeo.getAttribute(name).needsUpdate = true;
    this.laneGeo.index!.needsUpdate = true;
    this.uploads.lanes++;
  }

  private uploadMarkers(h: ScoreHistory): void {
    const n = h.markerCount;
    for (let i = 0; i < MARKER_CAPACITY; i++) {
      const v = i * 2;
      if (i < n) {
        const k = h.markerIndexOf(i);
        this.markT[v] = this.markT[v + 1] = h.markT[k];
        this.markS[v] = this.markS[v + 1] = h.markS[k];
      } else {
        this.markT[v] = this.markT[v + 1] = -1e9;
        this.markS[v] = this.markS[v + 1] = 0;
      }
    }
    this.markGeo.getAttribute("aT").needsUpdate = true;
    this.markGeo.getAttribute("aS").needsUpdate = true;
    this.uploads.markers++;
  }

  /**
   * Call when the WebGL context is lost. Releases the renderer's records of this scene's GPU objects while the context is
   * lost, but keeps the scene graph and the CPU-side arrays; the next draw after a restore uploads them again. The next
   * `update` also re-fills the buffers.
   */
  releaseGpu(): void {
    if (this.disposed) return;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.seenAppended = this.seenResets = this.seenOnsets = this.seenMarkers = -1;
  }

  /** Releases every geometry and material. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.scene.clear();
    sceneStats.disposed++;
  }

  private own<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private ownMat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
